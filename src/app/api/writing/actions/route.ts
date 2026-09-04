/**
 * 写作台写作动作(SSE 流式):续写/润色/扩写/缩写/大纲/去AI化。
 * 复刻自 ai-novel-writer actions 路由,上游改走 cloud-chat(平台 API 规则)。
 * 长文本去 AI 化自动分段逐块改写(保留段落边界,块间注入衔接参考)。
 */
import { cloudChat, cloudChatStream } from "@/lib/cloud-chat";
import { retrieveMemoryBlock } from "@/lib/hierarchical-retrieval";
import {
  actionTemperature,
  buildActionPrompt,
  splitChunks,
} from "@/lib/writing/prompts";
import { pumpUpstreamStream } from "@/lib/writing/upstream";
import { tail } from "@/lib/writing/text";
import type { WritingAction } from "@/lib/writing/types";

export const runtime = "nodejs";
export const maxDuration = 600;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

const VALID_ACTIONS: WritingAction[] = [
  "continue",
  "polish",
  "expand",
  "shorten",
  "outline",
  "deai",
];
/** 需要选中文本的动作 */
const NEEDS_SELECTION: WritingAction[] = ["polish", "expand", "shorten", "deai"];
/** 去 AI 化分段阈值:超过该字符数自动分块改写,保证长文本质量 */
const DEAI_CHUNK_THRESHOLD = 900;
/** 每块目标字符数(保留段落边界,尽量贴近) */
const DEAI_CHUNK_TARGET = 700;

type Body = {
  action?: WritingAction;
  selection?: string;
  before?: string;
  after?: string;
  instruction?: string;
  chapterTitle?: string;
  chatApiUrl?: string;
  chatApiKey?: string;
  chatModel?: string;
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Body | null;
  const action = body?.action;
  if (!action || !VALID_ACTIONS.includes(action)) {
    return Response.json({ error: "无效的写作动作" }, { status: 400 });
  }
  // 钳制 body 字段大小,防巨型 body DoS / 超长 prompt 撑爆上游 token 预算
  const selection = (body?.selection ?? "").slice(0, 200000).trim();
  if (NEEDS_SELECTION.includes(action) && !selection) {
    return Response.json({ error: "请先在编辑器中选中要处理的文字" }, { status: 400 });
  }
  const { chatApiUrl, chatApiKey, chatModel } = body ?? {};
  if (!chatApiUrl || !chatApiKey || !chatModel) {
    return Response.json(
      { error: "写作台未配置模型:点击右上角设置,选择提供商并填入 API Key" },
      { status: 400 }
    );
  }

  // 分级记忆召回(动作语境)
  const before = (body?.before ?? "").slice(0, 10000);
  const chapterTitle = (body?.chapterTitle ?? "").slice(0, 200);
  const query = selection || [chapterTitle, tail(before, 300)]
    .filter(Boolean)
    .join("\n");
  const memory = query.trim() ? await retrieveMemoryBlock(query.slice(0, 200)) : "";

  // 长文本去 AI 化:自动分段,逐块改写后拼接
  const chunked = action === "deai" && [...selection].length > DEAI_CHUNK_THRESHOLD;
  const chunks = chunked ? splitChunks(selection, DEAI_CHUNK_TARGET) : [];
  const temperature = Math.min(Math.max(actionTemperature(action), 0), 2);

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
      try {
        send({ type: "meta", action });

        if (chunked) {
          // —— 分段改写模式(每块非流式收集,块间拼接;上一块尾部作下一块衔接参考) ——
          let prevRewritten = "";
          for (let i = 0; i < chunks.length; i += 1) {
            const chunkText = chunks[i];
            const { system, user } = buildActionPrompt(
              {
                action: "deai",
                selection: chunkText,
                before,
                after: (body?.after ?? "").slice(0, 5000),
                prevTail: i > 0 ? tail(prevRewritten, 200) : tail(before, 200),
                instruction:
                  i > 0
                    ? "这是整章的第 " + (i + 1) + "/" + chunks.length +
                      " 段。请只改写本段;开头与【衔接参考】的内容自然衔接,不要重复其内容。标点规则按整章执行:全程不得新增破折号或省略号。"
                    : undefined,
                chapterTitle,
              },
              memory
            );
            const block = await cloudChat(
              [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              chatApiUrl,
              chatApiKey,
              chatModel,
              4096,
              temperature
            );
            const trimmedBlock = block.trim();
            if (trimmedBlock) {
              prevRewritten = trimmedBlock;
              send({ type: "delta", content: (i > 0 ? "\n\n" : "") + trimmedBlock });
            }
          }
          send({ type: "done" });
          return;
        }

        // —— 单次流式模式 ——
        const { system, user } = buildActionPrompt(
          {
            action,
            selection,
            before,
            after: (body?.after ?? "").slice(0, 5000),
            prevTail: action === "deai" ? tail(before, 200) : undefined,
            instruction: (body?.instruction ?? "").slice(0, 1000),
            chapterTitle,
          },
          memory
        );
        const upstream = await cloudChatStream(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          chatApiUrl,
          chatApiKey,
          chatModel,
          undefined,
          { maxTokens: 4096, temperature }
        );
        await pumpUpstreamStream(upstream, send);
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
          /* 已关闭 */
        }
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
