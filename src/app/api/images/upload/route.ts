import { NextRequest } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

/**
 * 安全加固（2026-08-30，2026-08-31 补充）：
 * - Origin 校验：拦截恶意网页跨站注入（CSRF）
 * - magic bytes 校验：只允许真实图片内容落盘，防 HTML/SVG/JS 等可执行内容
 * - 文件名：basename + 白名单字符清洗，扩展名由内容决定
 * - 大小上限 20MB：防磁盘/内存滥用
 */

/** 单文件大小上限 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 信任的来源主机（浏览器 Origin 校验用）。请求 Host 与 Origin 一致时天然放行；跨域仅允许这些本地/开发来源。 */
const TRUSTED_ORIGIN_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "100.86.102.69",
]);

/**
 * CSRF 防护：校验浏览器 Origin。
 * 无 Origin 头（curl / 服务端调用等非浏览器客户端）放行；
 * 有 Origin 时必须是同源或受信任主机，否则拒绝 —— 恶意网页跨站注入会被拦下。
 */
function isTrustedOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const hostHeader = request.headers.get("host") || "";
    return (
      o.host === hostHeader ||
      TRUSTED_ORIGIN_HOSTS.has(o.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

interface ImageSignature {
  ext: string;
  mime: string;
  test: (b: Buffer) => boolean;
}

/** 图片 magic bytes 检测表 */
const IMAGE_SIGNATURES: ImageSignature[] = [
  {
    ext: "png",
    mime: "image/png",
    test: (b) =>
      b.length >= 8 &&
      b
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: "jpg",
    mime: "image/jpeg",
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "gif",
    mime: "image/gif",
    test: (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "GIF8",
  },
  {
    ext: "webp",
    mime: "image/webp",
    test: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
  {
    ext: "bmp",
    mime: "image/bmp",
    test: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d,
  },
  {
    ext: "avif",
    mime: "image/avif",
    test: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 4, 8) === "ftyp" &&
      (b.toString("ascii", 8, 12) === "avif" ||
        b.toString("ascii", 8, 12) === "avis"),
  },
];

function detectImage(buffer: Buffer): ImageSignature | null {
  return IMAGE_SIGNATURES.find((s) => s.test(buffer)) ?? null;
}

export async function POST(request: NextRequest) {
  try {
    // CSRF 防护：跨站 Origin 直接拒绝
    if (!isTrustedOrigin(request)) {
      return Response.json({ error: "origin not allowed" }, { status: 403 });
    }

    const body = await request.json();
    const { filename, data } = body as {
      filename: string;
      data: string; // base64 encoded
    };

    if (!filename || !data) {
      return Response.json(
        { error: "filename and data are required" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(data, "base64");

    if (buffer.length === 0) {
      return Response.json({ error: "data is empty" }, { status: 400 });
    }
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: `文件过大（最大 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB）` },
        { status: 413 }
      );
    }

    // 内容校验：必须是真实图片（magic bytes），防止 HTML/SVG/JS 等可执行内容落盘
    const detected = detectImage(buffer);
    if (!detected) {
      return Response.json(
        { error: "only image files (png/jpg/gif/webp/bmp/avif) are allowed" },
        { status: 400 }
      );
    }

    // 文件名：取 basename 防目录穿越，去扩展名后清洗，扩展名由内容决定
    const base = path
      .basename(filename)
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 100);
    const safeFilename = `${base || "image"}.${detected.ext}`;

    // Ensure directory exists
    const generatedDir = path.join(process.cwd(), "public", "generated");
    await mkdir(generatedDir, { recursive: true });

    const filepath = path.join(generatedDir, safeFilename);
    await writeFile(filepath, buffer);

    return Response.json({
      url: `/generated/${safeFilename}`,
      contentType: detected.mime,
      size: buffer.length,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Image Upload API] Error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
