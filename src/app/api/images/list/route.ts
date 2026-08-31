import { readdir, readFile } from "fs/promises";
import path from "path";

interface ImageMeta {
  url: string;
  prompt: string;
  provider: string;
  createdAt: string;
  originalUrl?: string;
}

export async function GET() {
  try {
    const generatedDir = path.join(process.cwd(), "public", "generated");

    let files: string[];
    try {
      files = await readdir(generatedDir);
    } catch {
      // Directory doesn't exist yet
      return Response.json({ images: [] });
    }

    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    const images: ImageMeta[] = [];

    for (const metaFile of metaFiles) {
      try {
        const content = await readFile(
          path.join(generatedDir, metaFile),
          "utf-8"
        );
        const meta: ImageMeta = JSON.parse(content);
        images.push(meta);
      } catch {
        // Skip corrupted meta files
      }
    }

    // Sort by creation time, newest first
    images.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return Response.json({ images });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Images List API] Error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
