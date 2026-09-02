/**
 * 云端对话 API 客户端
 * 直接对接 OpenAI 兼容的云端模型 API(如七牛云、OpenAI、DeepSeek 等)
 *
 * 安全加固(2026-08-30,2026-08-31 重构):
 * - SSRF 防护统一收敛到 url-guard:https + 域名白名单 + DNS 内网/元数据拦截
 *   + 重定向逐跳校验(chatApiGuard)
 * - 上游响应体错误不再回显给客户端,防信息泄露/回显利用
 */

import {
  guardedFetch,
  assertFetchableUrl,
  UrlGuardError,
  type UrlGuardOptions,
} from "./url-guard";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 配置性错误(白名单/协议/解析问题),可安全回显给用户 */
export class ChatApiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatApiConfigError";
  }
}

/** 默认白名单(未配置 CHAT_API_ALLOWED_HOSTS 时使用) */
const DEFAULT_ALLOWED_HOSTS = [
  "api.qnaigc.com",
  "api.openai.com",
  "api.deepseek.com",
  "api.anthropic.com",
  "dashscope.aliyuncs.com",
];

function getAllowedHosts(): string[] {
  const env = process.env.CHAT_API_ALLOWED_HOSTS;
  if (!env || !env.trim()) return DEFAULT_ALLOWED_HOSTS;
  return env
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostMatches(host: string, allowed: string): boolean {
  if (allowed.startsWith("*.")) {
    const suffix = allowed.slice(1); // ".example.com"
    return host === allowed.slice(2) || host.endsWith(suffix);
  }
  return host === allowed;
}

/**
 * 对话上游的防护选项:https + 域名白名单 + 内网地址拦截。
 * 工具循环等直接调用上游的地方复用此配置(guardedFetch 每一跳重定向都会生效)。
 */
export function chatApiGuard(): UrlGuardOptions {
  return {
    httpsOnly: true,
    validateUrl: (u) => {
      const host = u.hostname.toLowerCase();
      const allowed = getAllowedHosts();
      if (!allowed.some((a) => hostMatches(host, a))) {
        throw new UrlGuardError(
          `对话 API 域名 ${host} 不在白名单内,请在 .env.local 的 CHAT_API_ALLOWED_HOSTS 中配置`
        );
      }
    },
  };
}

/**
 * 校验并规范化云端 API 地址:
 * 1. 必须是 https
 * 2. 域名必须在白名单内(CHAT_API_ALLOWED_HOSTS,默认内置常用服务)
 * 3. DNS 解析结果不得为内网/链路本地/元数据地址
 */
export async function validateChatApiUrl(apiBaseUrl: string): Promise<string> {
  try {
    const url = await assertFetchableUrl(apiBaseUrl, chatApiGuard());
    return url.toString().replace(/\/+$/, "");
  } catch (e) {
    if (e instanceof ChatApiConfigError) throw e;
    throw new ChatApiConfigError(
      e instanceof Error ? e.message : "对话 API 地址校验失败"
    );
  }
}

function clampMaxTokens(value: number | undefined): number {
  const n = Number(value) || 4096;
  return Math.min(Math.max(n, 256), 32768);
}

export interface CloudChatStreamOptions {
  /**
   * 跳过 SSRF 校验。仅用于服务端写死的地址(如本地 Ollama),
   * 绝不能用于客户端可控的 URL。
   */
  trustedUrl?: boolean;
  /** 请求的 max_tokens,默认 4096,范围 [256, 32768] */
  maxTokens?: number;
}

/**
 * 流式调用云端对话 API
 * 兼容 OpenAI /v1/chat/completions 格式
 */
export async function cloudChatStream(
  messages: ChatMessage[],
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
  options: CloudChatStreamOptions = {}
): Promise<ReadableStream> {
  const maxTokens = clampMaxTokens(options.maxTokens);
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: maxTokens,
    }),
    signal,
  };

  const response = options.trustedUrl
    ? await fetch(`${apiBaseUrl.replace(/\/+$/, "")}/chat/completions`, init)
    : await guardedFetch(
        `${await validateChatApiUrl(apiBaseUrl)}/chat/completions`,
        init,
        chatApiGuard()
      );

  if (!response.ok) {
    await response.text().catch(() => null); // 读完以释放连接,但不回显内容
    throw new Error(`Cloud API error: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body for streaming");
  }

  return response.body;
}

/**
 * 非流式调用云端对话 API
 */
export async function cloudChat(
  messages: ChatMessage[],
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  maxTokens?: number
): Promise<string> {
  const url = `${await validateChatApiUrl(apiBaseUrl)}/chat/completions`;

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
        messages,
        max_tokens: clampMaxTokens(maxTokens),
      }),
    },
    chatApiGuard()
  );

  if (!response.ok) {
    await response.text().catch(() => null);
    throw new Error(`Cloud API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? "";
}
