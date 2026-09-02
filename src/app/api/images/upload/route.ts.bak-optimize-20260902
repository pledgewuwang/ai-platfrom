import { NextRequest } from "next/server";

/**
 * 图片上传 API
 * 在服务端环境中将 base64 图片转换为 data URL 返回
 * 客户端可直接使用 data URL 显示图片
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filename, data, contentType } = body as {
      filename: string;
      data: string; // base64
      contentType: string;
    };

    if (!data) {
      return Response.json({ error: "No image data" }, { status: 400 });
    }

    // 直接返回 data URL，不需要写入文件系统
    // 这样 Vercel 等无文件系统的环境也能用
    const dataUrl = `data:${contentType || "image/png"};base64,${data}`;

    return Response.json({
      success: true,
      url: dataUrl,
      filename: filename || "uploaded-image",
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
