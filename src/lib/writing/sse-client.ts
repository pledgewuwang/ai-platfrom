"use client";

import type { SseEvent } from "./types";

/**
 * 消费写作台后端 SSE(fetch + ReadableReader;不用 EventSource,因为要 POST JSON body)。
 * 按 \n\n 分帧;TextDecoder stream 模式保证多字节中文跨 chunk 不乱码。
 * 流正常结束但没收到 done 事件 → 视为断流,上报 error。
 */
export async function streamSse(
  url: string,
  body: unknown,
  onEvent: (ev: SseEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = "请求失败(HTTP " + res.status + ")";
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* 非 JSON 错误体 */
    }
    onEvent({ type: "error", message });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let sawDone = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6)) as SseEvent;
            if (ev.type === "done") sawDone = true;
            onEvent(ev);
          } catch {
            /* 跳过损坏帧 */
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawDone) {
    onEvent({ type: "error", message: "连接中断,生成未完成,请重试" });
  }
}
