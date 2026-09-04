/**
 * 分级检索引擎 (Hierarchical Retrieval) 客户端
 * 封装对本地 HR 引擎 (localhost:8000) 的所有调用
 */

const HR_API_URL = process.env.HR_API_URL || "http://localhost:8000";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface IngestResponse {
  status: string;
  id?: string;
  message?: string;
}

export interface RetrieveResult {
  id: string;
  score: number;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RetrieveResponse {
  results: RetrieveResult[];
}

export interface HealthResponse {
  status: string;
  version?: string;
}

/**
 * 调用 HR 引擎的 /v1/chat/completions（自动上下文压缩）
 * 支持流式响应 (SSE)
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: {
    model?: string;
    stream?: boolean;
    onChunk?: (chunk: string) => void;
    signal?: AbortSignal;
  } = {}
): Promise<string | ReadableStream> {
  const { model = "default", stream = false, onChunk, signal } = options;

  const response = await fetch(`${HR_API_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, model, stream }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`HR Engine error: ${response.status} - ${errorText}`);
  }

  if (stream) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let fullContent = "";
    // SSE 事件可能跨网络分片:缓冲不完整的行,凑齐再解析
    let sseBuffer = "";

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) return;

      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          fullContent += content;
          onChunk?.(content);
        }
      } catch {
        // Skip malformed JSON lines
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? ""; // 最后一段可能不完整,留到下一轮

      for (const line of lines) {
        processLine(line);
      }
    }
    if (sseBuffer) processLine(sseBuffer);

    return fullContent;
  }

  const data: ChatCompletionResponse = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * 流式 chat completion - 返回 ReadableStream 用于 SSE 代理
 */
export async function chatCompletionStream(
  messages: ChatMessage[],
  model = "default",
  signal?: AbortSignal
): Promise<ReadableStream> {
  const response = await fetch(`${HR_API_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, model, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`HR Engine error: ${response.status} - ${errorText}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  return response.body;
}

/**
 * 摄入对话内容到 HR 引擎
 */
export async function ingestDialogue(
  content: string,
  metadata?: Record<string, unknown>
): Promise<IngestResponse> {
  const response = await fetch(`${HR_API_URL}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, metadata }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`HR ingest error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * 从 HR 引擎检索相关内容
 */
export async function retrieve(
  query: string,
  limit = 5
): Promise<RetrieveResponse> {
  const response = await fetch(`${HR_API_URL}/retrieve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`HR retrieve error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * 检查 HR 引擎健康状态
 */
export async function healthCheck(): Promise<HealthResponse> {
  const response = await fetch(`${HR_API_URL}/health`, {
    method: "GET",
  });

  if (!response.ok) {
    return { status: "error" };
  }

  return response.json();
}

/**
 * 分级记忆注入:取与 query 最相关的历史记忆块(标题+关键句+原文片段)。
 * 云端对话模式用:发给云端模型前把本地长期记忆装配进 system,
 * 让云端模型也"记得"本地分级检索库里的历史对话。
 * 失败静默(记忆服务不可用不应阻塞对话)。
 */
export async function retrieveMemoryBlock(
  query: string,
  limit = 3,
  timeoutMs = 15000
): Promise<string> {
  try {
    const res = await fetch(`${HR_API_URL}/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k_sentences: limit, top_k_context: 1 }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as {
      key_sentences?: { text: string; score: number }[];
      full_contexts?: { chunk_text?: string; score: number }[];
    };
    const parts: string[] = [];
    const ks = data.key_sentences || [];
    const fc = data.full_contexts || [];
    if (ks.length === 0 && fc.length === 0) return "";
    for (const k of ks.slice(0, limit)) {
      parts.push(`- ${k.text}`);
    }
    for (const c of fc.slice(0, 2)) {
      if (c.chunk_text) parts.push(`· 原文: ${c.chunk_text.slice(0, 200)}`);
    }
    if (parts.length === 0) return "";
    return (
      "以下是本地分级检索召回的历史记忆(与当前问题相关,供参考):\n" +
      parts.join("\n")
    );
  } catch {
    return "";
  }
}

/**
 * 对话后入库(异步,不阻塞响应):把本轮 user 提问与 assistant 回答
 * 写入分级检索库,长期记忆持续积累。失败静默。
 */
export async function ingestTurn(
  userText: string,
  assistantText: string
): Promise<void> {
  try {
    const content = `用户:${userText}\n助手:${assistantText}`;
    await fetch(`${HR_API_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, metadata: { source: "ai-platform", ts: Date.now() } }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    // 入库失败不影响对话
  }
}

/**
 * SVSG V5.2.1 结构化视觉分析结果入库(兼容增强):
 * 把"图片提问 + 最终答案 + 结构化断言"写入分级检索库,
 * 后续对话可通过检索召回此前的图片分析结论。失败静默。
 */
export async function ingestSvsgResult(
  query: string,
  result: {
    status?: string;
    final_answer?: string | null;
    claims?: Array<{
      instance_id?: number | null;
      field?: string;
      value?: unknown;
    }>;
  }
): Promise<void> {
  try {
    const claimLines = (result.claims ?? [])
      .slice(0, 12)
      .map(
        (c) =>
          (c.instance_id != null ? "#" + c.instance_id + " " : "") +
          (c.field ?? "?") + ": " + String(c.value ?? "")
      )
      .join("; ");
    const content =
      "用户(图片提问): " + query +
      "\nSVSG 视觉分析(status=" + (result.status ?? "unknown") + "): " +
      (result.final_answer ?? "(无最终答案)") +
      (claimLines ? "\n结构化断言: " + claimLines : "");
    await fetch(HR_API_URL + "/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: content.slice(0, 3000),
        metadata: { source: "ai-platform-svsg", ts: Date.now() },
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    // SVSG 结果入库失败不影响分析响应
  }
}
