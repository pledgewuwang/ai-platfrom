import { NextRequest } from "next/server";
import { chatCompletionStream, ChatMessage } from "@/lib/hr-client";
import {
  cloudChatStream,
  validateChatApiUrl,
  chatApiGuard,
} from "@/lib/cloud-chat";
import { guardedFetch } from "@/lib/url-guard";
import { AVAILABLE_TOOLS, executeTool, toolsToOpenAIFunctions, parseToolCalls } from "@/lib/tools";
import { buildVisionMessage, type MediaAttachment } from "@/lib/vision";

function clampMaxTokens(value: unknown): number {
  const n = Number(value) || 4096;
  return Math.min(Math.max(n, 256), 32768);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      messages,
      model = "default",
      chatApiUrl,
      chatApiKey,
      chatModel,
      conversationModel,
      enableTools = true, // 是否启用工具调用
      attachments,
      tokenBudget,
    } = body as {
      messages: ChatMessage[];
      model?: string;
      chatApiUrl?: string;
      chatApiKey?: string;
      chatModel?: string;
      conversationModel?: string;
      enableTools?: boolean;
      attachments?: MediaAttachment[];
      tokenBudget?: number;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return Response.json(
        { error: "messages array is required and must not be empty" },
        { status: 400 }
      );
    }

    const effectiveModel = conversationModel || chatModel || "default";
    const isOllama = effectiveModel.startsWith("ollama/");
    const maxTokens = clampMaxTokens(tokenBudget);

    // 图片/视频附件 → 视觉消息(只作用于本轮最后一条 user 消息;
    // 不支持视觉的模型由 buildVisionMessage 自动降级为文字占位)
    if (Array.isArray(attachments) && attachments.length > 0) {
      const lastUserIdx = messages.map((m) => m && m.role).lastIndexOf("user");
      if (lastUserIdx !== -1) {
        const visionMsg = buildVisionMessage(
          typeof messages[lastUserIdx].content === "string"
            ? (messages[lastUserIdx].content as string)
            : "",
          attachments,
          effectiveModel
        );
        messages[lastUserIdx] = {
          ...messages[lastUserIdx],
          content: visionMsg.content,
        } as ChatMessage;
      }
    }

    // 对于支持 function calling 的模型，启用工具循环
    if (enableTools && !isOllama && chatApiUrl && chatApiKey) {
      return await handleToolLoop(messages, chatApiUrl, chatApiKey, effectiveModel, maxTokens);
    }

    // 简单模式：直接流式响应
    let stream: ReadableStream;
    if (isOllama) {
      // 本地 Ollama:服务端固定地址(非客户端可控),跳过 SSRF 校验;
      // OpenAI 兼容端点在 /v1 下
      const ollamaUrl = "http://localhost:11434/v1";
      stream = await cloudChatStream(
        messages,
        ollamaUrl,
        "ollama",
        effectiveModel.replace("ollama/", ""),
        undefined,
        { trustedUrl: true, maxTokens }
      );
    } else if (chatApiUrl && chatApiKey && chatModel) {
      stream = await cloudChatStream(messages, chatApiUrl, chatApiKey, effectiveModel, undefined, {
        maxTokens,
      });
    } else {
      stream = await chatCompletionStream(messages, model);
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error: unknown) {
    const message = (error instanceof Error ? error.message : "Unknown error").slice(0, 200);
    console.error("[Chat API] Error:", message);

    const encoder = new TextEncoder();
    const errorStream = new ReadableStream({
      start(controller) {
        const data = JSON.stringify({
          choices: [{ delta: { content: `\n\n⚠️ Error: ${message}` } }],
        });
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(errorStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }
}

/**
 * 工具调用循环：AI 自主决定是否搜索/爬取
 */
async function handleToolLoop(
  messages: ChatMessage[],
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  maxTokens: number
): Promise<Response> {
  // 与 cloudChatStream 相同的 SSRF 防护:https + 白名单 + 内网地址拦截
  const baseUrl = await validateChatApiUrl(apiBaseUrl);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        let currentMessages = [...messages];
        let iterations = 0;
        const MAX_ITERATIONS = 5; // 防止无限循环
        // SSE 事件统一从这里发:
        // - 正文: {choices:[{delta:{content}}]}(与上游流式格式一致)
        // - 工具状态: {type:"tool_status",...}(前端渲染成独立 UI,不混入正文)
        // - 工具记忆: {type:"tool_summary",text}(前端存进消息,下轮随历史发回)
        // - 用量: {type:"usage",usage:{prompt_tokens,...}}
        const emit = (obj: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const toolSummaries: string[] = [];
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let lastHadToolCalls = false;

        while (iterations < MAX_ITERATIONS) {
          iterations++;

          // 调用 AI 模型（带工具定义;guardedFetch 对重定向逐跳校验）
          const url = `${baseUrl}/chat/completions`;
          console.log("[Chat API] 调用上游:", url, "model:", model);
          const t0 = Date.now();
          const response = await guardedFetch(
            url,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({
                model,
                // 兼容 Claude 系中转：tool 角色消息转换为 user，避免
                // "This model does not support assistant message prefill / must end with a user message" 400
                messages: currentMessages.map((m) => {
                  const mm = m as { role?: string; content?: unknown; tool_call_id?: string };
                  if (mm.role === "tool") {
                    return {
                      role: "user",
                      content: `[工具调用结果 ${mm.tool_call_id ?? ""}]\n${typeof mm.content === "string" ? mm.content : JSON.stringify(mm.content)}`,
                    };
                  }
                  return m;
                }),
                tools: toolsToOpenAIFunctions(AVAILABLE_TOOLS),
                tool_choice: "auto",
                max_tokens: maxTokens,
              }),
            },
            chatApiGuard()
          );

          console.log("[Chat API] 上游状态:", response.status, "耗时ms:", Date.now() - t0);
          if (!response.ok) {
            await response.text().catch(() => null); // 读完释放连接,但不回显上游错误内容
            throw new Error(`API error: ${response.status}`);
          }

          const data = await response.json();
          const choice = data.choices?.[0];
          console.log("[Chat API] choices:", data.choices?.length ?? 0, "hasToolCalls:", !!choice?.tool_calls, "finish:", choice?.finish_reason ?? "none");

          if (data.usage) {
            usage.prompt_tokens += data.usage.prompt_tokens ?? 0;
            usage.completion_tokens += data.usage.completion_tokens ?? 0;
            usage.total_tokens += data.usage.total_tokens ?? 0;
          }

          if (!choice) break;

          const message = choice.message;

          // 检查是否有工具调用
          const toolCalls = parseToolCalls({ choices: [{ message }] });
          lastHadToolCalls = toolCalls.length > 0;

          if (toolCalls.length === 0) {
            // 没有工具调用，直接返回最终回答
            const content = message?.content || "";
            if (content) {
              emit({ choices: [{ delta: { content }, finish_reason: "stop" }] });
            }
            break;
          }

          // 执行工具调用
          // 先把 assistant 消息（含 tool_calls）加入历史
          currentMessages.push({
            role: "assistant",
            content: message?.content || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          } as unknown as ChatMessage);

          // 执行每个工具并收集结果
          for (const tc of toolCalls) {
            // 工具状态走独立事件,前端渲染成可折叠的状态条,不混进正文
            emit({
              type: "tool_status",
              tool: tc.name,
              label: getToolActionName(tc.name),
              status: "running",
            });

            const result = await executeTool(tc);

            const detail = result.error
              ? `失败: ${result.error.slice(0, 120)}`
              : getToolDetail(tc.name, result.result);
            emit({
              type: "tool_status",
              tool: tc.name,
              label: getToolActionName(tc.name),
              status: "done",
              detail,
            });
            toolSummaries.push(
              `${tc.name}(${summarizeToolArgs(tc)}) → ${detail}`
            );

            // 把工具结果加入消息历史
            currentMessages.push({
              role: "tool",
              content: JSON.stringify(result.error ? { error: result.error } : result.result),
              tool_call_id: tc.id,
            } as unknown as ChatMessage);
          }

          // 继续循环，让 AI 基于工具结果生成回答
        }

        if (lastHadToolCalls) {
          // 轮数用尽时最后一轮还没产出正文,给个可见的收尾
          emit({ choices: [{ delta: { content: "\n\n（已达到工具调用轮数上限，回答在此截断）" } }] });
        }
        // 工具记忆摘要:前端存到本轮 assistant 消息上,下次请求随历史带回
        if (toolSummaries.length > 0) {
          emit({ type: "tool_summary", text: toolSummaries.join("; ").slice(0, 4000) });
        }
        // token 用量统计
        if (usage.total_tokens > 0) {
          emit({ type: "usage", usage });
        }

        // 发送结束信号
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const errData = JSON.stringify({
          choices: [{ delta: { content: `\n\n⚠️ Error: ${message}` } }],
        });
        controller.enqueue(encoder.encode(`data: ${errData}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function getToolActionName(toolName: string): string {
  switch (toolName) {
    case "web_search": return "搜索互联网";
    case "fetch_webpage": return "读取网页";
    case "search_and_read": return "搜索并阅读";
    case "generate_image": return "优化提示词并生成图片";
    default: return "执行工具";
  }
}

/** 工具参数的一句话摘要(用于工具记忆) */
function summarizeToolArgs(tc: { name: string; arguments: Record<string, unknown> }): string {
  const args = tc.arguments ?? {};
  const pick = (k: string) =>
    typeof args[k] === "string" ? (args[k] as string).slice(0, 60) : undefined;
  return pick("query") ?? pick("url") ?? pick("prompt") ?? "";
}

/** 工具结果的人话摘要(用于状态条与工具记忆) */
function getToolDetail(name: string, result: unknown): string {
  if (!result || typeof result !== "object") return "完成";
  const r = result as Record<string, unknown>;
  switch (name) {
    case "web_search": {
      const n = Array.isArray(r.results) ? r.results.length : 0;
      return `${n} 条结果`;
    }
    case "fetch_webpage":
      return typeof r.title === "string" && r.title
        ? `已读《${r.title.slice(0, 30)}》`
        : "已读";
    case "search_and_read": {
      const m = Array.isArray(r.searchResults) ? r.searchResults.length : 0;
      const n = Array.isArray(r.readings) ? r.readings.length : 0;
      return `${m} 条结果，已读 ${n} 篇`;
    }
    case "generate_image":
      return r.imageUrl ? "已生成图片" : "未返回图片";
    default:
      return "完成";
  }
}
