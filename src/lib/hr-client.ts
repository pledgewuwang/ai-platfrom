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
