/**
 * 智能网页爬虫
 * 爬取 → 解析 → 提取关键信息 → 压缩后才送给大模型
 * 避免把整个 HTML/动态页面内容塞进上下文导致 token 爆炸
 */

import * as cheerio from "cheerio";
import { guardedFetch, readTextWithCap } from "./url-guard";

export interface CrawlResult {
  url: string;
  title: string;
  // 提取后的关键信息（精简版）
  content: string;
  // 抓取失败时的错误信息（此时 content 为空）
  error?: string;
  // 元数据
  metadata: {
    description?: string;
    keywords?: string[];
    author?: string;
    publishDate?: string;
    siteName?: string;
  };
  // 提取的链接（如有需要）
  links: { text: string; href: string }[];
  // 统计
  stats: {
    originalSize: number;    // 原始 HTML 大小
    extractedSize: number;   // 提取后大小
    compressionRatio: number; // 压缩比
  };
}

export interface CrawlOptions {
  // 最大内容长度（字符数），超过则截断
  maxContentLength?: number;
  // 是否提取链接
  extractLinks?: boolean;
  // 最大链接数
  maxLinks?: number;
  // 要移除的标签（不提取内容）
  removeTags?: string[];
  // 自定义选择器（只提取指定区域）
  contentSelector?: string;
  // 请求超时
  timeout?: number;
  // User-Agent
  userAgent?: string;
}

const DEFAULT_OPTIONS: CrawlOptions = {
  maxContentLength: 8000,  // 默认最多 8000 字符，远小于 50K
  extractLinks: false,
  maxLinks: 20,
  removeTags: [
    "script", "style", "nav", "footer", "header",
    "aside", "iframe", "noscript", "svg", "form",
    "button", "input", "select", "textarea",
    "comment", "!--",
  ],
  timeout: 15000,
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

/**
 * 智能爬取并提取关键信息
 */
export async function smartCrawl(
  url: string,
  options: CrawlOptions = {}
): Promise<CrawlResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // 1. 爬取页面(带 SSRF 防护:协议/内网地址校验 + 重定向逐跳校验 + 响应大小上限)
  const response = await guardedFetch(url, {
    headers: { "User-Agent": opts.userAgent! },
    signal: AbortSignal.timeout(opts.timeout!),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const html = await readTextWithCap(response);
  const originalSize = html.length;

  // 2. 解析 HTML
  const $ = cheerio.load(html);

  // 3. 移除不需要的标签
  for (const tag of opts.removeTags!) {
    $(tag).remove();
  }

  // 4. 移除注释
  $.root()
    .contents()
    .each(function () {
      if (this.type === "comment") {
        $(this).remove();
      }
    });

  // 5. 提取标题
  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim() ||
    "Untitled";

  // 6. 提取元数据
  const metadata = {
    description: $('meta[name="description"]').attr("content") || undefined,
    keywords: $('meta[name="keywords"]')
      .attr("content")
      ?.split(",")
      .map((k) => k.trim())
      .slice(0, 10),
    author:
      $('meta[name="author"]').attr("content") ||
      $('[rel="author"]').text().trim() ||
      undefined,
    publishDate:
      $('meta[property="article:published_time"]').attr("content") ||
      $('meta[name="date"]').attr("content") ||
      undefined,
    siteName:
      $('meta[property="og:site_name"]').attr("content") || undefined,
  };

  // 7. 提取正文内容
  let content = "";

  if (opts.contentSelector) {
    // 使用自定义选择器
    content = $(opts.contentSelector).text().trim();
  } else {
    // 智能提取：优先 article > main > .content > body
    const contentSelectors = ["article", "main", '[role="main"]', ".content", ".post", ".article", "#content"];

    for (const sel of contentSelectors) {
      const extracted = $(sel).text().trim();
      if (extracted.length > 100) {
        content = extracted;
        break;
      }
    }

    // 兜底：用 body
    if (!content) {
      content = $("body").text().trim();
    }
  }

  // 8. 清理文本
  content = cleanText(content);

  // 9. 截断到最大长度
  if (opts.maxContentLength && content.length > opts.maxContentLength) {
    content = content.slice(0, opts.maxContentLength) + "\n\n[... 内容已截断]";
  }

  // 10. 提取链接（可选）
  let links: { text: string; href: string }[] = [];
  if (opts.extractLinks) {
    links = $("a[href]")
      .slice(0, opts.maxLinks)
      .toArray()
      .map((el) => ({
        text: $(el).text().trim().slice(0, 100),
        href: $(el).attr("href") || "",
      }))
      .filter((l) => l.text && l.href);
  }

  // 11. 计算压缩比
  const compressionRatio =
    originalSize > 0
      ? Math.round(((originalSize - content.length) / originalSize) * 100)
      : 0;

  return {
    url,
    title,
    content,
    metadata,
    links,
    stats: {
      originalSize,
      extractedSize: content.length,
      compressionRatio,
    },
  };
}

/**
 * 批量爬取多个 URL
 */
export async function smartCrawlBatch(
  urls: string[],
  options: CrawlOptions = {},
  concurrency = 3
): Promise<CrawlResult[]> {
  const results: CrawlResult[] = [];
  const queue = [...urls];

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift()!;
      try {
        const result = await smartCrawl(url, options);
        results.push(result);
      } catch (error) {
        // 失败不吞掉:返回错误条目,保证 count 与请求的 urls 对得上
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error(`[Crawler] Failed: ${url}`, message);
        results.push({
          url,
          title: "抓取失败",
          content: "",
          metadata: {},
          links: [],
          stats: { originalSize: 0, extractedSize: 0, compressionRatio: 0 },
          error: message,
        });
      }
    }
  }

  // 并发控制
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * 将爬取结果格式化为大模型友好的文本
 */
export function formatForLLM(result: CrawlResult): string {
  const parts: string[] = [];

  parts.push(`# ${result.title}`);
  parts.push(`URL: ${result.url}`);

  if (result.metadata.description) {
    parts.push(`\n描述: ${result.metadata.description}`);
  }
  if (result.metadata.author) {
    parts.push(`作者: ${result.metadata.author}`);
  }
  if (result.metadata.publishDate) {
    parts.push(`发布日期: ${result.metadata.publishDate}`);
  }

  parts.push(`\n--- 正文内容 ---\n`);
  parts.push(result.content);

  if (result.links.length > 0) {
    parts.push(`\n--- 相关链接 ---`);
    for (const link of result.links) {
      parts.push(`- ${link.text}: ${link.href}`);
    }
  }

  parts.push(
    `\n--- 统计 ---\n原始大小: ${result.stats.originalSize} 字符 | 提取后: ${result.stats.extractedSize} 字符 | 压缩率: ${result.stats.compressionRatio}%`
  );

  return parts.join("\n");
}

/**
 * 清理文本：移除多余空白、换行等
 */
function cleanText(text: string): string {
  return text
    // 移除多余空白
    .replace(/\s+/g, " ")
    // 移除多余换行
    .replace(/\n\s*\n/g, "\n\n")
    // 移除首尾空白
    .trim();
}

/**
 * 从 URL 判断是否需要特殊处理（动态页面检测）
 */
export function detectDynamicPage(url: string): {
  isDynamic: boolean;
  reason?: string;
} {
  const dynamicPatterns = [
    { pattern: /twitter\.com|x\.com/i, reason: "Twitter/X 动态加载" },
    { pattern: /instagram\.com/i, reason: "Instagram 动态加载" },
    { pattern: /facebook\.com/i, reason: "Facebook 动态加载" },
    { pattern: /linkedin\.com\/feed/i, reason: "LinkedIn Feed 动态加载" },
    { pattern: /reddit\.com/i, reason: "Reddit 动态加载" },
    { pattern: /tiktok\.com/i, reason: "TikTok 动态加载" },
  ];

  for (const { pattern, reason } of dynamicPatterns) {
    if (pattern.test(url)) {
      return { isDynamic: true, reason };
    }
  }

  return { isDynamic: false };
}
