import { NextRequest } from "next/server";
import { chatCompletionStream, ChatMessage, retrieveMemoryBlock, ingestTurn } from "@/lib/hr-client";
import {
  cloudChatStream,
  validateChatApiUrl,
  chatApiGuard,
  clampMaxTokens,
} from "@/lib/cloud-chat";
import { guardedFetch } from "@/lib/url-guard";
import {
  getEnabledTools,
  executeTool,
  toolsToOpenAIFunctions,
  safeParseArguments,
  type ToolCall,
  type ToolResult,
} from "@/lib/tools";
import { buildVisionMessage, type MediaAttachment } from "@/lib/vision";
import { runSubAgents, formatSubAgentResults, type SubAgent } from "@/lib/sub-agent";
import { cloudChat } from "@/lib/cloud-chat";

/** SSE 响应头(正文流与错误流共用) */
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/** 工具调用链路的可配置项(前端设置面板下发) */
interface ToolSettings {
  /** 工具循环最大轮数,默认 5,范围 [1, 10] */
  maxRounds?: number;
  /** 启用的工具白名单(按名称),空/缺省 = 全部 */
  enabledTools?: string[];
  /** web_search 后自动阅读前 2 条结果全文,默认 true */
  autoRead?: boolean;
  /** 同一轮多个工具并行执行,默认 true */
  parallel?: boolean;
  /** GitHub 个人访问令牌(可选,提升 API 限额 60→5000 次/小时) */
  githubToken?: string;
}

/** 构造一个只含一条错误消息 + [DONE] 的 SSE 流 */
function sseErrorStream(message: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const data = JSON.stringify({
        choices: [{ delta: { content: `\n\n⚠️ Error: ${message}` } }],
      });
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** 发给模型的工具结果里,正文类字段的最大字符数(超出截断) */
const TOOL_CONTENT_CAP = 2500;

/** Agent 集群:每路同构编程 agent 的 system 提示词(要求产出完整可运行代码) */
const CLUSTER_AGENT_PROMPT = "You are a senior software engineer. Given the user's programming request, produce a complete, runnable, self-contained solution. Mark each file with a fenced code block. Be concise; skip prose and explanations.";

/**
 * 压缩工具结果,再进入模型上下文(省 token):
 * - 去掉模型用不到的字段:stats(爬取统计)、note(静态说明文字)
 * - content 类长文本截断到 TOOL_CONTENT_CAP
 * 只影响发给模型的内容;前端状态条用的是单独的 detail 摘要,不受影响。
 */
function compactToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = { ...(result as Record<string, unknown>) };
  delete r.stats;
  delete r.note;

  const trunc = (s: unknown): unknown =>
    typeof s === "string" && s.length > TOOL_CONTENT_CAP
      ? s.slice(0, TOOL_CONTENT_CAP)
      : s;

  r.content = trunc(r.content);
  for (const key of ["autoFetched", "readings"] as const) {
    if (Array.isArray(r[key])) {
      r[key] = (r[key] as unknown[]).map((x) =>
        x && typeof x === "object"
          ? { ...(x as Record<string, unknown>), content: trunc((x as Record<string, unknown>).content) }
          : x
      );
    }
  }
  return r;
}

/**
 * Agent 统一记忆模式的共享上下文:最近对话摘要 + 分级记忆召回。
 * 隔离模式不调用(保持子 Agent 独立、token 最省)。
 * 压缩预算:单条消息 400 字符、对话总量 2000、加上记忆块后总上限 3200。
 */
async function buildAgentSharedContext(
  messages: ChatMessage[]
): Promise<string | undefined> {
  const dialogue = messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
  );
  if (dialogue.length === 0) return undefined;

  // 最近 6 条对话摘要
  let hist = dialogue
    .slice(-6)
    .map(
      (m) =>
        (m.role === "user" ? "用户: " : "助手: ") +
        (m.content as string).slice(0, 400)
    )
    .join("\n");
  if (hist.length > 2000) hist = "…" + hist.slice(-2000);

  // 分级记忆召回(与本轮问题最相关的历史记忆)
  const lastUser =
    [...dialogue].reverse().find((m) => m.role === "user")?.content ?? "";
  const mem =
    lastUser && lastUser.length >= 6
      ? await retrieveMemoryBlock(lastUser.slice(0, 200))
      : "";

  const parts: string[] = [];
  if (mem) parts.push(mem);
  if (hist) parts.push("最近对话摘要:\n" + hist);
  if (parts.length === 0) return undefined;
  return parts.join("\n\n").slice(0, 3200);
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
      toolSettings,
      attachments,
      tokenBudget,
      codeMode = false,
      codeLanguage = "auto",
      temperature,
    } = body as {
      codeMode?: boolean;
      codeLanguage?: string;
      messages: ChatMessage[];
      model?: string;
      chatApiUrl?: string;
      chatApiKey?: string;
      chatModel?: string;
      conversationModel?: string;
      enableTools?: boolean;
      toolSettings?: ToolSettings;
      attachments?: MediaAttachment[];
      tokenBudget?: number;
      temperature?: number;
      imageApiKey?: string;
    };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return Response.json(
        { error: "messages array is required and must not be empty" },
        { status: 400 }
      );
    }

    // 决定本轮实际使用的模型(子 Agent / 主对话 / 工具循环 都要用):
    //  - conversationModel:本对话可覆盖全局
    //  - chatModel:前端下发的全局模型
    //  - model:旧版兼容
    // 必须放在所有引用 effectiveModel 的代码之前,否则子 Agent 块就 ReferenceError
    const effectiveModel = conversationModel || chatModel || model;
    // 温度钳制 [0,2]:前端输入可能越界,直接透传会被上游 400 拒绝
    const safeTemperature =
      typeof temperature === "number" ? Math.min(Math.max(temperature, 0), 2) : undefined;

    // ── Agent 记忆模式 ──
    // isolated:子 Agent 只见分工任务(默认,最省 token);
    // unified:为子 Agent/集群注入共享上下文(最近对话摘要 + 分级记忆召回)
    const agentMemoryMode =
      (body as Record<string, unknown>).agentMemoryMode === "unified"
        ? ("unified" as const)
        : ("isolated" as const);
    const agentSharedContext =
      agentMemoryMode === "unified"
        ? await buildAgentSharedContext(messages)
        : undefined;

    // ── 子 Agent 分工模式 ──
    // 前端可随请求下发 subAgents:[];每个子 Agent 独立调用一次非流式 chat,
    // 所有结果汇总后作为一条额外的 user 消息注入主对话上下文,
    // 由主模型基于子结果生成最终答复。
    // 子 Agent 可指定 modelName,支持「降级模型」(用便宜小模型处理机械子任务)。
    const subAgents = Array.isArray((body as Record<string, unknown>).subAgents)
      ? ((body as Record<string, unknown>).subAgents as SubAgent[])
      : [];
    if (subAgents.length > 0) {
      // 统一记忆模式:给每个子 Agent 附上共享上下文(隔离模式为 undefined)
      const safeAgents = subAgents
        .slice(0, 6)
        .map((a) => ({ ...a, contextText: agentSharedContext }));
      const subResults = await runSubAgents(
        async (params) => {
          // 集群/分工每路可带独立 url/key,否则回落到主对话配置
          const url = params.apiUrl || chatApiUrl || "";
          const key = params.apiKey || chatApiKey || "";
          if (!url || !key) {
            throw new Error("子 Agent/集群需要 chatApiUrl/chatApiKey(在设置里配置云端模型)");
          }
          const content = await cloudChat(
            params.messages as { role: "system" | "user" | "assistant"; content: string }[],
            url,
            key,
            params.model,
            params.max_tokens,
            params.temperature,
            params.signal,
          );
          return { content };
        },
        safeAgents,
        effectiveModel
      );
      const summary = formatSubAgentResults(subResults);
      if (summary) {
        let lastUserIdx = messages.length;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user") { lastUserIdx = i; break; }
        }
        messages.splice(lastUserIdx, 0, {
          role: "system",
          content: "[子 Agent 分工结果 — 共 " + subResults.length + " 个;仅供参考,引用时按 [role] 标记]\n" + summary,
        } as ChatMessage);
      }
    }

    // ── Agent 集群模式 ──
    // 编程模式下可并行 N 路(1-4)同构 Agent 各自独立产出方案,结果汇总注入上下文,
    // 主模型基于多路方案综合出最终答复。每路可带独立 apiUrl/key/model(可填相同 key)。
    const agentCluster = (body as Record<string, unknown>).agentCluster as
      | { enabled?: boolean; count?: number; apiUrls?: string[]; keys?: string[]; models?: string[] }
      | undefined;
    // 与子 Agent 分工互斥:两者同开会双份子调用+双份注入,token 翻倍且结果互相干扰
    if (codeMode && agentCluster?.enabled && subAgents.length === 0) {
      const clusterCount = Math.min(Math.max(agentCluster.count ?? 2, 1), 4);
      const keys = Array.isArray(agentCluster.keys) ? agentCluster.keys : [];
      const urls = Array.isArray(agentCluster.apiUrls) ? agentCluster.apiUrls : [];
      const models = Array.isArray(agentCluster.models) ? agentCluster.models : [];
      // 集群 user 消息:取本轮最后一条用户消息(编程请求原文)
      let clusterUserMsg = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") { clusterUserMsg = messages[i].content; break; }
      }
      if (clusterUserMsg) {
        const clusterAgents: SubAgent[] = Array.from({ length: clusterCount }, (_, i) => ({
          id: "cluster-" + i,
          role: "方案 " + (i + 1),
          systemPrompt: CLUSTER_AGENT_PROMPT,
          userMessage: clusterUserMsg,
          contextText: agentSharedContext,
          modelName: models[i] || effectiveModel,
          apiUrl: urls[i] || undefined,
          apiKey: keys[i] || undefined,
        }));
        const clusterResults = await runSubAgents(
          async (params) => {
            const url = params.apiUrl || chatApiUrl || "";
            const key = params.apiKey || chatApiKey || "";
            if (!url || !key) {
              throw new Error("Agent 集群需要 chatApiUrl/chatApiKey(在设置里配置云端模型)");
            }
            const content = await cloudChat(
              params.messages as { role: "system" | "user" | "assistant"; content: string }[],
              url,
              key,
              params.model,
              params.max_tokens,
              params.temperature,
              params.signal,
            );
            return { content };
          },
          clusterAgents,
          effectiveModel
        );
        const clusterSummary = formatSubAgentResults(clusterResults, {
          maxCharsPerAgent: 2000,
          maxTotalChars: 8000,
        });
        if (clusterSummary) {
          let lastUserIdx = messages.length;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "user") { lastUserIdx = i; break; }
          }
          messages.splice(lastUserIdx, 0, {
            role: "system",
            content:
              "[Agent 集群方案 — 共 " + clusterResults.length + " 路;每路独立模型生成,请综合对比后给出最佳实现]\n" +
              clusterSummary,
          } as ChatMessage);
        }
      }
    }

    const isOllama = effectiveModel.startsWith("ollama/");
    // 编程模式:用最短的 system prompt 给模型发「按编程场景回答」信号,
    // token 预算自动降一档(代码生成典型只需要 2-4K 就能给出可用答案),
    // 用户可在设置里关闭编程模式以恢复正常对话行为。
    let effectiveTokenBudget = tokenBudget;
    if (codeMode) {
      const lang = codeLanguage && codeLanguage !== "auto" ? codeLanguage : "";
      const langHint = lang ? ` Focus on ${lang}.` : "";
      const codingSystemPrompt = `You are a senior software engineer. Answer concisely with runnable code.${langHint} Avoid prose, emojis, and explanations unless asked. Prefer minimal diffs.`;
      messages.unshift({ role: "system", content: codingSystemPrompt } as ChatMessage);
      effectiveTokenBudget = Math.min(effectiveTokenBudget ?? 4096, 2048);
    }
    // 编程模式下用降档后的预算,其余场景保持原值
    const maxTokens = codeMode ? clampMaxTokens(effectiveTokenBudget) : clampMaxTokens(tokenBudget);
    // 白名单过滤后没有可用工具时,走普通流式(连 tools 字段都不发,省 token)
    const activeTools = enableTools
      ? getEnabledTools(toolSettings?.enabledTools)
      : [];

    // 图片/视频附件 → 视觉消息(只作用于本轮最后一条 user 消息;
    // 不支持视觉的模型由 buildVisionMessage 自动降级为文字占位)
    if (Array.isArray(attachments) && attachments.length > 0) {
      const lastUserIdx = messages.map((m) => m && m.role).lastIndexOf("user");
      if (lastUserIdx !== -1) {
        // 完全体管线:支持视觉的模型直传图片;纯文本模型走
        // 「视觉模型看图 → 函数解参描述注入」(async,本地 Ollama)
        const visionMsg = await buildVisionMessage(
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
    if (activeTools.length > 0 && !isOllama && chatApiUrl && chatApiKey) {
      return await handleToolLoop(
        messages,
        chatApiUrl,
        chatApiKey,
        effectiveModel,
        maxTokens,
        activeTools,
        toolSettings ?? {},
        body.imageApiKey,
        safeTemperature
      );
    }

    // ── 分级记忆注入(云端对话) ──
    // 发给云端模型前,从本地分级检索库召回相关历史记忆注入 system,
    // 让云端模型也"记得"本地长期记忆(HR 服务不可用时静默跳过)。
    let lastUserText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserText = typeof messages[i].content === "string" ? messages[i].content : "";
        break;
      }
    }
    if (!isOllama && chatApiUrl && lastUserText && lastUserText.length >= 6) {
      const memoryBlock = await retrieveMemoryBlock(lastUserText.slice(0, 200));
      if (memoryBlock) {
        messages.unshift({ role: "system", content: memoryBlock } as ChatMessage);
      }
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
        { trustedUrl: true, maxTokens, temperature: safeTemperature }
      );
    } else if (chatApiUrl && chatApiKey && chatModel) {
      // 云端直连(带记忆注入后的 messages)
      stream = await cloudChatStream(messages, chatApiUrl, chatApiKey, effectiveModel, undefined, {
        maxTokens,
        temperature: safeTemperature,
      });
    } else {
      stream = await chatCompletionStream(messages, model);
    }

    // ── 对话后入库(分级记忆持续积累) ──
    // 用 TransformStream 拦截 SSE:提取 assistant 输出全文,流结束后
    // fire-and-forget 写入分级检索库(失败静默,不阻塞响应)。
    if (!isOllama && lastUserText && lastUserText.length >= 6) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let assistantText = "";
      const tapped = stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            const text = decoder.decode(chunk, { stream: true });
            // 解析 SSE data: 行,提取 delta.content(OpenAI 流式格式)
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (!payload || payload === "[DONE]") continue;
              try {
                const j = JSON.parse(payload);
                const delta = j.choices?.[0]?.delta?.content;
                if (typeof delta === "string") assistantText += delta;
              } catch { /* 忽略非 JSON 行 */ }
            }
            controller.enqueue(encoder.encode(text));
          },
          // 入库时机:流真正结束(flush)。原先固定延迟 15s,工具循环经常超时,
          // 会把不完整的回答写进分级记忆库
          flush() {
            if (assistantText.trim()) {
              ingestTurn(userSnapshot, assistantText.slice(0, 20000)).catch(() => {});
            }
          },
        })
      );
      const userSnapshot = lastUserText;
      return new Response(tapped, { headers: SSE_HEADERS });
    }

    return new Response(stream, { headers: SSE_HEADERS });
  } catch (error: unknown) {
    const message = (error instanceof Error ? error.message : "Unknown error").slice(0, 200);
    console.error("[Chat API] Error:", message);
    return new Response(sseErrorStream(message), { headers: SSE_HEADERS });
  }
}

/**
/**
 * 工具调用循环：AI 自主决定是否搜索/爬取
 *
 * 设计思路（工程心理学）:
 * - 每个 helper 函数只做一件事(single responsibility)，降低认知负荷
 * - 主循环线性可读：调用模型 → 检查工具调用 → 执行工具 → 重复
 * - SSE 渐进式反馈：running → done，前端始终知道当前进度
 * - 错误就近处理：HTTP/JSON/工具错误各自独立处理
 */
async function handleToolLoop(
  messages: ChatMessage[],
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  activeTools: ReturnType<typeof getEnabledTools>,
  toolSettings: ToolSettings,
  imageApiKey?: string,
  temperature?: number
): Promise<Response> {
  // SSRF 防护:https + 白名单 + 内网地址拦截
  const baseUrl = await validateChatApiUrl(apiBaseUrl);

  // 轮数上限 [1, 10]
  const MAX_ITERATIONS = Math.min(Math.max(toolSettings.maxRounds ?? 5, 1), 10);
  const parallel = toolSettings.parallel !== false;
  const toolOpts = {
    autoRead: toolSettings.autoRead !== false,
    githubToken: toolSettings.githubToken || undefined,
    imageApiKey,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const currentMessages = [...messages];
        let iterations = 0;
        let lastHadToolCalls = false;

        // SSE 统一发送器
        const emit = (obj: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        // 工具结果缓存：避免同一请求内重复执行相同调用（防循环空转）
        const toolCache = new Map<string, ToolResult>();
        // 工具记忆摘要：前端存库，下次请求带回
        const toolSummaries: string[] = [];
        // Token 用量累计
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        // ── Helper: 构建发给上游的消息列表 ──
        // Claude 系中转不支持 tool 角色消息，转换为 user 避免 400
        const buildUpstreamMessages = () =>
          currentMessages.map((m) => {
            const mm = m as { role?: string; content?: unknown; tool_call_id?: string };
            if (mm.role === "tool") {
              return {
                role: "user" as const,
                content:
                  `[工具调用结果 ${mm.tool_call_id ?? ""}]\n` +
                  (typeof mm.content === "string" ? mm.content : JSON.stringify(mm.content)),
              };
            }
            return m;
          });

        // ── Helper: 调用上游模型 ──
        const callUpstream = async (msgs: ChatMessage[]) => {
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
                messages: msgs,
                tools: toolsToOpenAIFunctions(activeTools),
                tool_choice: "auto" as const,
                max_tokens: maxTokens,
                ...(temperature !== undefined ? { temperature } : {}),
              }),
            },
            chatApiGuard()
          );
          console.log("[Chat API] 上游状态:", response.status, "耗时ms:", Date.now() - t0);
          if (!response.ok) {
            await response.text().catch(() => null); // 释放连接
            throw new Error(`上游 API 返回 ${response.status}`);
          }
          return response.json();
        };

        // ── Helper: 从响应中提取工具调用 ──
        // GPT-5 使用 parallel_tool_calls finish_reason 表示并行调用，
        // 此时 tool_calls 字段依然存在，照常提取
        const extractToolCalls = (data: unknown): { calls: ToolCall[]; hasContent: boolean } => {
          const resp = data as { choices?: unknown[] };
          const choice = (Array.isArray(resp.choices) ? resp.choices[0] : undefined) as
            | { message?: { content?: unknown; tool_calls?: unknown[] } }
            | undefined;
          const message = choice?.message;
          const rawCalls = message?.tool_calls;
          const calls: ToolCall[] = [];
          if (Array.isArray(rawCalls)) {
            for (const tc of rawCalls) {
              const toolCall = tc as { id?: string; function?: { name?: string; arguments?: unknown } };
              const fn = toolCall.function ?? {};
              calls.push({
                id: toolCall.id ?? `tool_${Date.now()}`,
                name: fn.name ?? "unknown_tool",
                arguments: safeParseArguments(fn.arguments),
              });
            }
          }
          const hasContent =
            typeof message?.content === "string" && message.content.trim().length > 0;
          return { calls, hasContent };
        };

        // ── Helper: 发送工具执行状态（前端进度条用） ──
        const emitToolStatus = (
          tc: ToolCall,
          status: "running" | "done",
          detail?: string
        ) => {
          emit({
            type: "tool_status",
            tool: tc.name,
            label: getToolActionName(tc.name),
            status,
            detail,
          });
        };

        // ── Helper: 执行单条工具调用（含缓存复用） ──
        const runSingleTool = async (tc: ToolCall): Promise<ToolResult> => {
          const cached = toolCache.get(cacheKey(tc));
          if (cached) {
            emitToolStatus(tc, "done", `${getToolDetail(tc.name, cached.result)}（缓存复用）`);
            return { ...cached, toolCallId: tc.id };
          }
          emitToolStatus(tc, "running");
          const result = await executeTool(tc, toolOpts);
          toolCache.set(cacheKey(tc), result);
          const detail = result.error
            ? `失败: ${result.error.slice(0, 120)}`
            : getToolDetail(tc.name, result.result);
          emitToolStatus(tc, "done", detail);
          toolSummaries.push(`${tc.name}(${summarizeToolArgs(tc)}) → ${detail}`);
          return { ...result, toolCallId: tc.id };
        };

        // ── Helper: 将工具结果加入消息历史（压缩后省 token） ──
        const appendToolResult = (tc: ToolCall, result: ToolResult) => {
          currentMessages.push({
            role: "tool",
            content: JSON.stringify(
              result.error ? { error: result.error } : compactToolResult(result.result)
            ),
            tool_call_id: tc.id,
          } as unknown as ChatMessage);
        };

        // ═══════════════════════════════════════════════════════
        // 主循环：每一轮 = 调一次模型 → 有工具调用则执行 → 继续
        // ═══════════════════════════════════════════════════════
        while (iterations < MAX_ITERATIONS) {
          iterations++;

          // Step 1: 调用上游模型
          let data: unknown;
          try {
            data = await callUpstream(buildUpstreamMessages());
          } catch (err) {
            throw err instanceof Error ? err : new Error("调用模型失败");
          }

          // Step 2: 累计 token 用量
          const d = data as Record<string, unknown>;
          if (d.usage && typeof d.usage === "object") {
            const u = d.usage as {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
            };
            usage.prompt_tokens += u.prompt_tokens ?? 0;
            usage.completion_tokens += u.completion_tokens ?? 0;
            usage.total_tokens += u.total_tokens ?? 0;
          }

          // Step 3: 提取工具调用
          const { calls: toolCalls, hasContent } = extractToolCalls(data);
          lastHadToolCalls = toolCalls.length > 0;

          // Step 4: 无工具调用 → 流式输出正文并结束
          if (toolCalls.length === 0) {
            const choice = (Array.isArray(d.choices) ? d.choices[0] : undefined) as
              | { message?: { content?: unknown } }
              | undefined;
            const content =
              typeof choice?.message?.content === "string" ? choice.message.content : "";
            if (content) {
              emit({ choices: [{ delta: { content }, finish_reason: "stop" }] });
            }
            break;
          }

          // Step 5: 把 assistant 消息加入历史
          const assistantContent = (Array.isArray(d.choices) ? d.choices[0] : undefined) as
            | { message?: { content?: unknown } }
            | undefined;
          currentMessages.push({
            role: "assistant",
            content:
              hasContent && typeof assistantContent?.message?.content === "string"
                ? assistantContent.message.content
                : null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          } as unknown as ChatMessage);

          // Step 6: 执行工具调用（并行/串行由 parallel 开关控制）
          const results = await (parallel && toolCalls.length > 1
            ? (async () => {
                // 并行：每个工具由 runSingleTool 自己发送 running / done，避免重复状态
                const settled = await Promise.allSettled(
                  toolCalls.map((tc) => runSingleTool(tc))
                );
                return toolCalls.map((tc, j) => {
                  const s = settled[j];
                  const result: ToolResult = s.status === "fulfilled"
                    ? s.value
                    : { toolCallId: tc.id, name: tc.name, result: null, error: "工具执行异常" };
                  toolCache.set(cacheKey(tc), result);
                  return result;
                });
              })()
            : (async () => {
                // 串行：按顺序逐一执行
                const results: ToolResult[] = [];
                for (const tc of toolCalls) {
                  results.push(await runSingleTool(tc));
                }
                return results;
              })());

          // Step 7: 把工具结果加入历史
          for (let i = 0; i < toolCalls.length; i++) {
            appendToolResult(toolCalls[i], results[i]);
          }

          // 继续下一轮：AI 基于工具结果生成回答
        }

        // ── 收尾 ──
        if (lastHadToolCalls) {
          emit({ choices: [{ delta: { content: "\n\n（已达到工具调用轮数上限，回答在此截断）" } }] });
        }
        if (toolSummaries.length > 0) {
          emit({ type: "tool_summary", text: toolSummaries.join("; ").slice(0, 1200) });
        }
        if (usage.total_tokens > 0) {
          emit({ type: "usage", usage });
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "未知错误";
        const errData = JSON.stringify({
          choices: [{ delta: { content: `\n\n⚠️ 错误: ${message}` } }],
        });
        controller.enqueue(encoder.encode(`data: ${errData}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
/** 缓存键:工具名 + 参数 JSON(同一请求内标识一次完全相同的调用) */
function cacheKey(tc: ToolCall): string {
  return `${tc.name}:${JSON.stringify(tc.arguments)}`;
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
