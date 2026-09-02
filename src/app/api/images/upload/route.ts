import { NextRequest } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";

/** 客户端校验上限(图片 10MB)对应 base64 后约 13.4MB 字符 */
const MAX_BASE64_LENGTH = 14 * 1024 * 1024;

/** contentType 不可信,白名单决定落盘后缀 */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * 图片上传 API
 * 落盘到 public/generated/uploads,返回持久 URL —— 历史/多端刷新后仍能显示。
 * 只读文件系统(如 Vercel)写入失败时降级为 data URL(仅当次会话可见)。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filename, data, contentType } = body as {
      filename: string;
      data: string; // base64(不带 data: 前缀)
      contentType: string;
    };

    if (!data || typeof data !== "string") {
      return Response.json({ error: "No image data" }, { status: 400 });
    }

    // 服务端校验:类型白名单 + 大小上限(客户端校验可被绕过)
    const type = (contentType || "").toLowerCase();
    const ext = IMAGE_EXT[type];
    if (!ext) {
      return Response.json(
        { error: `不支持的图片类型: ${type || "未知"}` },
        { status: 400 }
      );
    }
    if (data.length > MAX_BASE64_LENGTH) {
      return Response.json({ error: "图片过大(上限 10MB)" }, { status: 400 });
    }
    // base64 粗校验:合法字符集
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return Response.json({ error: "图片数据格式不正确" }, { status: 400 });
    }

    const dataUrl = `data:${type};base64,${data}`;

    try {
      const buffer = Buffer.from(data, "base64");
      if (buffer.length === 0) {
        return Response.json({ error: "图片数据为空" }, { status: 400 });
      }

      const uploadDir = path.join(process.cwd(), "public", "generated", "uploads");
      await mkdir(uploadDir, { recursive: true });

      // 文件名不信任客户端:时间戳 + 随机 UUID + 白名单后缀
      const safeName = `${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`;
      await writeFile(path.join(uploadDir, safeName), buffer);

      return Response.json({
        success: true,
        url: `/generated/uploads/${safeName}`,
        filename: filename || "uploaded-image",
      });
    } catch {
      // 只读文件系统:降级 data URL(与旧行为一致,仅当次会话可见)
      return Response.json({
        success: true,
        url: dataUrl,
        filename: filename || "uploaded-image",
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
