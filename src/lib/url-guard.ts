/**
 * 出站请求防护(SSRF)
 * 服务端发起的所有"目标地址来自用户输入"的请求统一走这里:
 * - 只允许 http/https
 * - 域名解析结果不得为内网/链路本地/云元数据/保留地址
 * - 重定向逐跳校验(redirect: manual),防止公网页面 302 跳内网
 * - 响应体大小上限,防止超大页面撑爆内存
 */

import { lookup } from "node:dns/promises";

export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlGuardError";
  }
}

/** IPv4:内网/链路本地/元数据/保留地址拦截 */
export function isBlockedIpv4(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return true;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT(Tailscale 等)
  if (a === 169 && b === 254) return true; // 链路本地 / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // 组播/保留
  return false;
}

/** 判断 IP 是否为内网/链路本地/元数据/保留地址(IPv4 + IPv6) */
export function isBlockedIp(ip: string): boolean {
  const v = ip.toLowerCase();
  // IPv4-mapped IPv6(::ffff:a.b.c.d)
  if (v.startsWith("::ffff:")) {
    return isBlockedIpv4(v.slice(7));
  }
  // IPv6
  if (v.includes(":")) {
    if (v === "::1" || v.startsWith("fe80:")) return true; // 环回 / 链路本地
    const firstGroup = parseInt(v.split(":")[0] || "0", 16);
    if (Number.isNaN(firstGroup)) return true;
    if (firstGroup >= 0xfc00 && firstGroup < 0xfe00) return true; // ULA fc00::/7
    if (firstGroup >= 0xff00) return true; // 多播 ff00::/8
    // 仅放行全局单播 2000::/3(0x2000-0x3fff)
    return firstGroup < 0x2000 || firstGroup > 0x3fff;
  }
  return isBlockedIpv4(v);
}

/** 域名解析:所有解析结果都不得命中内网段 */
async function assertHostnamePublic(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ""); // URL hostname 可能带 IPv6 方括号
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new UrlGuardError(`域名 ${host} 无法解析`);
  }
  if (addresses.length === 0) {
    throw new UrlGuardError(`域名 ${host} 无法解析`);
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new UrlGuardError(`域名 ${host} 解析到内网/保留地址(${address}),已拒绝`);
    }
  }
}

export interface UrlGuardOptions {
  /** 仅允许 https */
  httpsOnly?: boolean;
  /** 每一跳(含重定向)的额外校验,如域名白名单 */
  validateUrl?: (url: URL) => Promise<void> | void;
}

/** 校验单个 URL:协议 + 自定义校验 + 解析地址;通过后返回 URL 对象 */
export async function assertFetchableUrl(
  raw: string,
  opts: UrlGuardOptions = {}
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError("URL 格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlGuardError("地址只支持 http/https");
  }
  if (opts.httpsOnly && url.protocol === "http:") {
    throw new UrlGuardError("地址必须使用 https");
  }
  // 白名单等廉价校验放在 DNS 解析之前,报错更精准
  await opts.validateUrl?.(url);
  await assertHostnamePublic(url.hostname);
  return url;
}

const MAX_REDIRECTS = 5;

/**
 * 带防护的 fetch:入口与每一跳重定向都过 assertFetchableUrl。
 * 用法与 fetch 一致,额外传第三参数。
 */
export async function guardedFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: UrlGuardOptions = {}
): Promise<Response> {
  let url = await assertFetchableUrl(rawUrl, opts);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      await res.body?.cancel().catch(() => {});
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new UrlGuardError("重定向地址无效");
      }
      url = await assertFetchableUrl(next.toString(), opts);
      continue;
    }
    return res;
  }
  throw new UrlGuardError("重定向次数过多");
}

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** 读取响应文本,超过 maxBytes 抛错(防超大页面撑爆内存) */
export async function readTextWithCap(
  response: Response,
  maxBytes = MAX_TEXT_BYTES
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error(`响应过大(${contentLength} 字节),超过 ${maxBytes} 字节上限`);
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        break;
      }
      received += r.value.byteLength;
      if (received > maxBytes) {
        throw new Error(`响应过大,超过 ${maxBytes} 字节上限`);
      }
      text += decoder.decode(r.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    if (!done) reader.cancel().catch(() => {});
  }
  return text;
}
