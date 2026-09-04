import { NextRequest } from "next/server";
import { retrieveMemoryBlock, ingestSvsgResult } from "@/lib/hr-client";

/**
 * SVSG V5.2.1(结构化视觉语义网关)代理路由
 *
 * 前端 POST { imageBase64, mimeType, query, apiUrl, apiKey }
 *  → 转发 multipart 到 SVSG 服务的 /v1/analyze-image
 *  → 透传结构化结果(status/claims/final_answer/...)
 *
 * 说明:SVSG 是用户自配的本地/内网服务(默认 127.0.0.1:3002),
 * 不走 url-guard 的 SSRF 白名单(那只放行 https 公网域),
 * 这里只做协议校验(http/https)+ 超时 + 尺寸上限。
 */

interface SvsgAnalyzeBody {
  imageBase64?: string;
  mimeType?: string;
  query?: string;
  apiUrl?: string;
  apiKey?: string;
  /** 分级记忆联动(默认 true):分析前召回相关历史记忆拼进 query */
  useMemory?: boolean;
}

/** 图片 base64 上限 8MB(足够 4K 图) */
const MAX_IMAGE_B64 = 8 * 1024 * 1024;

/**
 * SVSG 地址限定为本地回环/内网:该路由的目标地址由请求体下发,
 * 限定私网可防止被当作访问公网任意地址的跳板;云元数据段(169.254)
 * 与公网域名一律拒绝(SVSG 的部署形态是本地/局域网服务)。
 */
function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (host.includes(":")) return host === "::1"; // IPv6 仅放行环回
  return false; // 公网域名等:拒绝
}

export async function POST(request: NextRequest) {
  let body: SvsgAnalyzeBody;
  try {
    body = (await request.json()) as SvsgAnalyzeBody;
  } catch {
    return Response.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }

  const { imageBase64, mimeType, query, apiUrl, apiKey, useMemory } = body;
  if (!imageBase64 || !mimeType) {
    return Response.json({ error: "缺少图片数据(imageBase64/mimeType)" }, { status: 400 });
  }
  if (imageBase64.length > MAX_IMAGE_B64) {
    return Response.json({ error: "图片过大(上限 8MB)" }, { status: 413 });
  }
  if (!query || !query.trim()) {
    return Response.json({ error: "缺少 query(要对图片提出的问题)" }, { status: 400 });
  }
  if (query.length > 2000) {
    return Response.json({ error: "query 过长(SVSG 上限 2000 字符)" }, { status: 400 });
  }
  if (!apiUrl) {
    return Response.json({ error: "缺少 SVSG 服务地址,请在设置中配置" }, { status: 400 });
  }

  // 服务地址规范化:去尾斜杠,只允许 http/https,且仅限本地回环/内网地址
  let base: string;
  try {
    const u = new URL(apiUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    if (!isLocalNetworkHost(u.hostname)) {
      throw new Error("not local");
    }
    base = apiUrl.replace(/\/+$/, "");
  } catch {
    return Response.json(
      { error: "SVSG 服务地址不合法(需 http/https,且仅限本机/内网地址如 127.0.0.1、192.168.x.x)" },
      { status: 400 }
    );
  }

  // ── 分级记忆联动(SVSG × 分级检索兼容增强) ──
  // 分析前召回相关历史记忆(如此前分析过的同类图片结论)拼进 query,
  // 让 SVSG 的问答带上历史上下文;无记忆/失败则原样转发。
  let svsgQuery = query.trim();
  if (useMemory !== false) {
    const mem = await retrieveMemoryBlock(svsgQuery.slice(0, 200), 3, 5000);
    if (mem) {
      // SVSG 端 query 上限 2000 字符:记忆压缩到 800
      svsgQuery = (mem.slice(0, 800) + "\n[当前问题] " + svsgQuery).slice(0, 2000);
    }
  }

  // base64 → 二进制(转成独立 ArrayBuffer,兼容 BlobPart 类型)
  let imageBuffer: ArrayBuffer;
  try {
    imageBuffer = Uint8Array.from(Buffer.from(imageBase64, "base64")).buffer as ArrayBuffer;
  } catch {
    return Response.json({ error: "图片 base64 解码失败" }, { status: 400 });
  }
  if (imageBuffer.byteLength === 0) {
    return Response.json({ error: "图片数据为空" }, { status: 400 });
  }

  // 转发 multipart(SVSG /v1/analyze-image 契约:query + file)
  const form = new FormData();
  form.append("query", svsgQuery);
  form.append("file", new Blob([imageBuffer], { type: mimeType }), "image");
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-API-Key"] = apiKey;

  try {
    const res = await fetch(base + "/v1/analyze-image", {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(90000),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return Response.json(
        { error: "SVSG 返回非 JSON(HTTP " + res.status + "): " + text.slice(0, 200) },
        { status: 502 }
      );
    }
    // 分析成功的结构化结果异步写入分级库:后续对话可通过检索召回图片结论
    if (data && typeof data === "object" && "status" in data) {
      const st = (data as { status?: string }).status ?? "";
      if (st.startsWith("delivered")) {
        void ingestSvsgResult(query.trim(), data as Parameters<typeof ingestSvsgResult>[1]);
      }
    }
    // 业务级结果(rejected/aborted/delivered* 等)按 SVSG 语义透传
    return Response.json(data, { status: res.status === 200 ? 200 : 502 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "请求失败";
    return Response.json(
      { error: "无法连接 SVSG 服务(" + base + "): " + message + "。请确认服务已启动" },
      { status: 502 }
    );
  }
}
