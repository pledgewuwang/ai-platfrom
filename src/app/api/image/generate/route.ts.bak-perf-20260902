import { NextRequest } from "next/server";
import { generateImage, type ImageProvider } from "@/lib/image-gen";
import { guardedFetch } from "@/lib/url-guard";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { prompt, apiKey, apiProvider = "flux" } = body as {
      prompt: string;
      apiKey: string;
      apiProvider: ImageProvider;
    };

    if (!prompt) {
      return Response.json({ error: "prompt is required" }, { status: 400 });
    }

    if (!apiKey) {
      return Response.json(
        { error: "apiKey is required. Configure it in Settings." },
        { status: 400 }
      );
    }

    // Generate image via provider API
    const result = await generateImage(prompt, apiKey, apiProvider);

    // Download and save locally
    // data: URL 是本地字节,无 SSRF 风险;http(s) 走防护(防伪造的上游把下载地址指向内网)
    const imageResponse = result.url.startsWith("data:")
      ? await fetch(result.url)
      : await guardedFetch(result.url);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download generated image: ${imageResponse.status}`);
    }

    const buffer = Buffer.from(await imageResponse.arrayBuffer());

    // Ensure directory exists
    const generatedDir = path.join(process.cwd(), "public", "generated");
    await mkdir(generatedDir, { recursive: true });

    // Create filename
    const timestamp = Date.now();
    const safeName = prompt
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_")
      .slice(0, 50);
    const filename = `${timestamp}_${safeName}.png`;
    const filepath = path.join(generatedDir, filename);

    await writeFile(filepath, buffer);

    // Save metadata
    const metaPath = path.join(generatedDir, `${filename}.meta.json`);
    const meta = {
      url: `/generated/${filename}`,
      prompt,
      provider: apiProvider,
      createdAt: new Date().toISOString(),
      originalUrl: result.url,
    };
    await writeFile(metaPath, JSON.stringify(meta, null, 2));

    return Response.json({
      url: `/generated/${filename}`,
      prompt,
      provider: apiProvider,
      createdAt: meta.createdAt,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Image Generate API] Error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
