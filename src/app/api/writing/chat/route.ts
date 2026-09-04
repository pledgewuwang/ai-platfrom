/**
 * 写作台 AI 对话(SSE 流式)
 * 与平台对话完全相同的 API 规则:cloudChatStream(https + 域名白名单 +
 * 内网拦截 + 按域名分 Key),模型配置直接用平台的对话设置。
 * 分级记忆:召回相关历史记忆注入 system;回答完成后入库积累。
 */
import { cloudChatStream } from "@/lib/cloud-chat";
import { retrieveMemoryBlock, ingestTurn } from "@/lib/hierarchical-retrieval";
import { buildChatMessages } from "@/lib/writing/prompts";
import { pumpUpstreamStream } from "@/lib/writing/upstream";

export const runtime = "nodejs";
export const maxDuration = 300;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

type Body = {
  messages?: { role: string; content: string }[];
  chapterContext?: { title?: string; cursorBefore?: string };
  chatApiUrl?: string;
  chatApiKey?: string;
  chatModel?: string;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Body | null;
  const history = (body?.messages ?? [])
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-10);

  if (history.length === 0) {
    return Response.json({ error: "没有可回复的消息" }, { status: 400 });
  }
  const { chatApiUrl, chatApiKey, chatModel } = body ?? {};
  if (!chatApiUrl || !chatApiKey || !chatModel) {
    return Response.json(
      { error: "写作台未配置模型:点击右上角设置,选择提供商并填入 API Key" },
      { status: 400 }
    );
  }

  // 钳制 chapterContext 大小,防巨型 body DoS
  const ctx = body?.chapterContext
    ? {
        title: (body.chapterContext.title ?? "").slice(0, 200),
        cursorBefore: (body.chapterContext.cursorBefore ?? "").slice(0, 5000),
      }
    : undefined;
  // 分级记忆:用最后一条用户消息 + 章节标题召回相关历史记忆
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const query = [ctx?.title, lastUser?.content].filter(Boolean).join("\n");
  const memory = query.trim() ? await retrieveMemoryBlock(query.slice(0, 200)) : "";

  const payload = buildChatMessages(history, memory, ctx);
  const lastUserText = lastUser?.content ?? "";

  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await cloudChatStream(payload, chatApiUrl, chatApiKey, chatModel, undefined, {
      maxTokens: 4096,
      temperature: 0.7,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message.slice(0, 200) : "上游连接失败" },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // enqueue/close 在客户端 abort 后会抛 TypeError("Invalid state"),
      // 全部包 try/catch,避免服务端日志噪声与中断后继续写
      const send = (ev: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode("data: " + JSON.stringify(ev) + "\n\n"));
        } catch {
          closed = true;
        }
      };
      let assistantText = "";
      try {
        send({ type: "memory", text: memory });
        assistantText = await pumpUpstreamStream(upstream, send);
        send({ type: "done" });
      } catch (e) {
        send({
          type: "error",
          message: e instanceof Error ? e.message.slice(0, 200) : "生成失败",
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* 客户端中断后 close 可能已调用 */
        }
        // 对话后入库(异步,不阻塞响应):写作讨论也进入分级记忆
        if (lastUserText && assistantText.trim()) {
          void ingestTurn(lastUserText.slice(0, 500), assistantText.slice(0, 20000));
        }
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
