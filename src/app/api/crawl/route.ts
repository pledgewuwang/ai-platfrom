import { NextRequest } from "next/server";
import { smartCrawl, smartCrawlBatch, formatForLLM, detectDynamicPage, type CrawlOptions } from "@/lib/smart-crawler";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      urls,
      options = {},
      format = "raw", // "raw" | "llm"
    } = body as {
      urls: string | string[];
      options?: CrawlOptions;
      format?: "raw" | "llm";
    };

    if (!urls) {
      return Response.json(
        { error: "urls is required (string or array)" },
        { status: 400 }
      );
    }

    const urlList = Array.isArray(urls) ? urls : [urls];

    // 检测动态页面
    const dynamicWarnings: { url: string; reason: string }[] = [];
    for (const url of urlList) {
      const detection = detectDynamicPage(url);
      if (detection.isDynamic) {
        dynamicWarnings.push({ url, reason: detection.reason! });
      }
    }

    let results;
    if (urlList.length === 1) {
      const result = await smartCrawl(urlList[0], options);
      results = [result];
    } else {
      results = await smartCrawlBatch(urlList, options);
    }

    // 格式化输出
    const output =
      format === "llm"
        ? results.map(formatForLLM).join("\n\n---\n\n")
        : results;

    return Response.json({
      success: true,
      count: results.length,
      dynamicWarnings: dynamicWarnings.length > 0 ? dynamicWarnings : undefined,
      data: output,
      stats: results.map((r) => ({
        url: r.url,
        title: r.title,
        originalSize: r.stats.originalSize,
        extractedSize: r.stats.extractedSize,
        compressionRatio: r.stats.compressionRatio,
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Crawl API] Error:", message);
    return Response.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
