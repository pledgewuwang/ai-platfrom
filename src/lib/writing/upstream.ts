/**
 * 读取 cloudChatStream 上游 SSE,把 delta 转发为写作台 SSE 事件;返回全文。
 * (chat / actions 两个路由共用)
 */
export async function pumpUpstreamStream(
  upstream: ReadableStream<Uint8Array>,
  send: (ev: { type: "delta"; content: string }) => void
): Promise<string> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  // 抽取单行解析逻辑,流末与中途共用
  const parseLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data: ")) return;
    const payload = t.slice(6);
    if (!payload || payload === "[DONE]") return;
    try {
      const j = JSON.parse(payload) as {
        choices?: { delta?: { content?: unknown } }[];
      };
      const delta = j.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        full += delta;
        send({ type: "delta", content: delta });
      }
    } catch {
      /* 忽略非 JSON 行 */
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? ""; // 最后一段可能不完整,留到下一轮
      for (const line of lines) parseLine(line);
    }
    // 流结束后解析残留 buf(此前被 pop 留作下一轮,若上游在 [DONE] 之后还有
    // 收尾行,会一直留到此处)
    if (buf) {
      parseLine(buf);
      buf = "";
    }
  } finally {
    reader.releaseLock();
  }
  return full;
}
