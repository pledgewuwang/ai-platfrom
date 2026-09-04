/**
 * AI 工具系统（Function Calling）
 * 定义 AI 可以调用的工具，让 AI 自己决定何时搜索、爬取网页
 */

import { guardedFetch, readTextWithCap } from "./url-guard";
import { smartCrawl } from "./smart-crawler";

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  error?: string;
}

/** executeTool 的可选行为开关(由请求方的设置传入) */
export interface ToolOptions {
  /** web_search 后是否自动阅读前 2 条结果全文,默认 true */
  autoRead?: boolean;
  /** GitHub 个人访问令牌(可选,公共数据无需登录;配置后限额 60→5000 次/小时) */
  githubToken?: string;
  /** 图片生成 API Key(由前端从用户设置中传入,避免服务端读 env 拿到 provider 名而非 key) */
  imageApiKey?: string;
}

// 定义可用工具
export const AVAILABLE_TOOLS: Tool[] = [
  {
    name: "web_search",
    description:
      "搜索互联网获取最新信息。当需要查找实时信息、新闻、技术文档、产品信息等时使用。" +
      "可选限定来源:zhihu=知乎、xiaohongshu=小红书、baidu=百度、bing=必应、weixin=微信公众号文章;" +
      "默认 all=全网聚合(必应+百度并行,兜底搜狗+Yahoo)。" +
      "查中文生活经验/测评/攻略建议 zhihu 或 xiaohongshu,查公众号文章用 weixin,查中文网页信息可用 baidu。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词",
        },
        num_results: {
          type: "number",
          description: "返回结果数量，默认 5",
        },
        site: {
          type: "string",
          description:
            "限定搜索来源:all=全网聚合(默认)、zhihu=知乎、xiaohongshu=小红书、baidu=百度、bing=必应、weixin=微信公众号",
          enum: ["all", "zhihu", "xiaohongshu", "baidu", "bing", "weixin"],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_webpage",
    description: "获取指定 URL 的网页内容并提取关键信息。当需要阅读特定网页、文章、文档时使用。",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要访问的网页 URL",
        },
        max_length: {
          type: "number",
          description: "最大提取字符数，默认 5000",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "search_and_read",
    description:
      "先搜索再阅读最相关的结果。当需要调研某个话题并获取详细信息时使用。" +
      "可选 site 参数限定来源:zhihu=知乎、xiaohongshu=小红书、baidu=百度、weixin=微信公众号。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "搜索关键词",
        },
        read_top: {
          type: "number",
          description: "阅读前几个搜索结果，默认 3",
        },
        site: {
          type: "string",
          description:
            "限定搜索来源:all=全网聚合(默认)、zhihu=知乎、xiaohongshu=小红书、baidu=百度、bing=必应、weixin=微信公众号",
          enum: ["all", "zhihu", "xiaohongshu", "baidu", "bing", "weixin"],
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "github",
    description:
      "查询 GitHub 公开仓库/代码/issue。查找开源项目、看仓库信息、读源码文件、查 issue、看提交历史时使用。" +
      "action:search_repos=搜仓库(默认)、repo_info=仓库详情+README、read_file=读文件、" +
      "search_issues=搜 issue、commits=最近提交。公共数据无需登录。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "要执行的操作",
          enum: ["search_repos", "repo_info", "read_file", "search_issues", "commits"],
        },
        query: {
          type: "string",
          description: "search_repos/search_issues 的搜索关键词",
        },
        repo: {
          type: "string",
          description: "owner/name 格式的仓库全名,repo_info/read_file/search_issues/commits 必填",
        },
        path: {
          type: "string",
          description: "read_file 的文件路径,如 src/index.ts 或 package.json",
        },
        per_page: {
          type: "number",
          description: "返回条数上限,默认 5,最大 10",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_image",
    description: "根据描述生成图片。当用户要求生成图片、画图、创建图像时使用。AI 可以自动优化提示词以获得更好的效果。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片描述（AI 会自动优化此提示词）",
        },
        style: {
          type: "string",
          description: "风格偏好",
          enum: ["realistic", "artistic", "cartoon", "anime", "photographic"],
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
];

/**
 * 按白名单过滤工具。
 * enabledTools 为空数组/未传时返回全部(向后兼容旧客户端)。
 */
export function getEnabledTools(enabledTools?: string[]): Tool[] {
  if (!enabledTools || enabledTools.length === 0) return AVAILABLE_TOOLS;
  const allow = new Set(enabledTools);
  return AVAILABLE_TOOLS.filter((t) => allow.has(t.name));
}

/**
 * 执行工具调用
 */
export async function executeTool(
  toolCall: ToolCall,
  opts: ToolOptions = {}
): Promise<ToolResult> {
  try {
    let result: unknown;

    switch (toolCall.name) {
      case "web_search":
        result = await toolWebSearch(
          toolCall.arguments.query as string,
          (toolCall.arguments.num_results as number) || 5,
          {
            autoFetch: opts.autoRead !== false,
            site: typeof toolCall.arguments.site === "string" ? toolCall.arguments.site : undefined,
          }
        );
        break;

      case "fetch_webpage":
        result = await toolFetchWebpage(
          toolCall.arguments.url as string,
          clampMaxLength(toolCall.arguments.max_length)
        );
        break;

      case "search_and_read":
        result = await toolSearchAndRead(
          toolCall.arguments.query as string,
          (toolCall.arguments.read_top as number) || 3,
          typeof toolCall.arguments.site === "string" ? toolCall.arguments.site : undefined
        );
        break;

      case "github":
        result = await toolGithub(
          {
            action: (toolCall.arguments.action as string) || "search_repos",
            query: typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "",
            repo: typeof toolCall.arguments.repo === "string" ? toolCall.arguments.repo : "",
            path: typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : "",
            per_page: toolCall.arguments.per_page as number | undefined,
          },
          opts.githubToken
        );
        break;

      case "generate_image":
        result = await toolGenerateImage(
          toolCall.arguments.prompt as string,
          (toolCall.arguments.style as string) || "realistic",
          { imageApiKey: opts.imageApiKey }
        );
        break;

      default:
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: null,
          error: `Unknown tool: ${toolCall.name}`,
        };
    }

    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: message,
    };
  }
}

/** max_length 服务端钳制:模型可能传任意值,超长内容白耗 token */
function clampMaxLength(raw: unknown): number {
  const n = Number(raw) || 5000;
  return Math.min(Math.max(n, 500), 20000);
}

/**
 * 定向来源定义。知乎/小红书直连有登录墙+反爬,统一走必应 site: 定向检索;
 * 百度尝试直连抓取(失败降级必应全网)。
 */
const SITE_FILTERS: Record<string, { domain: string; label: string }> = {
  zhihu: { domain: "zhihu.com", label: "知乎" },
  xiaohongshu: { domain: "xiaohongshu.com", label: "小红书" },
  bing: { domain: "", label: "必应" },
};

/**
 * 工具：网页搜索
 * - site=all: 必应+百度并行聚合,再按 URL 域名标注来源(知乎/小红书/百度/必应)
 * - site=zhihu/xiaohongshu: 必应 site: 域名定向检索,结果只保留该域名
 * - site=baidu: 百度直连,失败降级必应全网
 * @param opts.autoFetch 搜索后是否自动抓取前 2 条结果全文(search_and_read
 *   自会阅读,传入 false 避免重复抓取同一页面)
 */
async function toolWebSearch(
  query: string,
  numResults: number,
  opts: { autoFetch?: boolean; site?: string } = {}
) {
  const site =
    opts.site && (opts.site === "baidu" || opts.site === "weixin" || SITE_FILTERS[opts.site])
      ? opts.site
      : "all";
  const fetchNum = Math.max(numResults * 3, 15);
  let items: { title: string; snippet: string; url: string }[];

  if (site === "all") {
    // 全网聚合:必应+百度并行
    items = await searchWeb(query, fetchNum);
  } else if (site === "baidu") {
    // 百度直连,反爬拦截时降级必应全网
    try {
      items = await searchBaidu(query, fetchNum);
      if (items.length === 0) items = await searchBing(query, fetchNum);
    } catch (e) {
      console.warn("[Tools] 百度直连失败,降级必应:", e);
      items = await searchBing(query, fetchNum);
    }
  } else if (site === "bing") {
    items = await searchBing(query, fetchNum);
  } else if (site === "weixin") {
    // 微信公众号文章:搜狗微信(独家来源);触发验证码/空结果时降级搜狗网页
    try {
      items = await searchSogouWeixin(query, fetchNum);
      if (items.length === 0) items = await searchSogou(query, fetchNum);
    } catch (e) {
      console.warn("[Tools] 搜狗微信失败,降级搜狗网页:", e);
      items = await searchSogou(query, fetchNum);
    }
  } else {
    // 知乎/小红书:必应 site: 定向(域名过滤,必应偶尔忽略 site: 指令)+
    // 百度 site: 定向并行(百度对知乎/小红书收录更全;直连可能反爬,失败静默忽略)。
    // 百度结果是 baidu.com/link 跳转链接,真实域名在 302 后,不做域名过滤。
    const f = SITE_FILTERS[site];
    const [bingR, baiduR] = await Promise.allSettled([
      searchBing(query + " site:" + f.domain, fetchNum),
      searchBaidu("site:" + f.domain + " " + query, fetchNum),
    ]);
    const fromBing = bingR.status === "fulfilled" ? bingR.value : [];
    const fromBaidu = baiduR.status === "fulfilled" ? baiduR.value : [];
    const seenTitle = new Set<string>();
    items = [
      ...fromBing
        .filter((r) => r.url.includes(f.domain))
        .map((r) => ({ ...r, url: normalizeBaiduOrZhihuLink(r.url) })),
      ...fromBaidu,
    ].filter((r) => {
      const key = r.title.slice(0, 60);
      if (!key || seenTitle.has(key)) return false;
      seenTitle.add(key);
      return true;
    });
  }

  const categorize = (url: string): string => {
    if (url.includes("weixin.qq.com")) return "微信";
    if (url.includes("zhihu.com")) return "知乎";
    if (url.includes("xiaohongshu.com")) return "小红书";
    if (url.includes("baidu.com")) return "百度";
    return "必应";
  };

  const allResults: { title: string; snippet: string; url: string; source: string }[] =
    items.map((item) => ({ ...item, source: categorize(item.url) }));
  // 定向搜索:统一标注为所选来源(百度 link 跳转链接的域名是 baidu.com,会被误标)
  if (site === "zhihu" || site === "xiaohongshu") {
    const label = SITE_FILTERS[site].label;
    for (const r of allResults) r.source = label;
  } else if (site === "weixin") {
    for (const r of allResults) r.source = "微信";
  }

  const sourceOrder = ["必应", "百度", "知乎", "小红书", "微信"];
  const seen = new Set<string>();
  const deduped = allResults
    .sort((a, b) => sourceOrder.indexOf(a.source) - sourceOrder.indexOf(b.source))
    .filter((r) => {
      const key = r.url || r.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const results = deduped.slice(0, numResults);

  // 自动抓取前 2 个最相关结果的全文(并行抓取,互不阻塞)
  let autoFetch: unknown[] = [];
  if (opts.autoFetch !== false) {
    const targets = results.filter((r) => r.url && r.url.startsWith("http")).slice(0, 2);
    const settled = await Promise.allSettled(
      targets.map((item) => toolFetchWebpage(item.url, 2500))
    );
    autoFetch = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  }

  const usedSources = [...new Set(results.map((r) => r.source))];
  const hasResults = results.length > 0;
  // 定向搜索空结果时明确告诉模型该来源没搜到,避免它误以为工具坏了
  const siteLabel =
    site === "zhihu" || site === "xiaohongshu" ? SITE_FILTERS[site].label
    : site === "baidu" ? "百度"
    : site === "bing" ? "必应"
    : site === "weixin" ? "微信公众号"
    : "";

  // 返回体保持精简:每个字段都会进模型上下文按 token 计费,
  // 静态说明文字(note)之类一律不加
  return {
    query,
    results: results.map(({ source, ...rest }) => ({ ...rest, source })),
    autoFetched: autoFetch.length > 0 ? autoFetch : undefined,
    source: hasResults ? usedSources.join("+") : "no-results",
    siteNote:
      !hasResults && siteLabel ? siteLabel + " 没有搜到结果,建议换关键词或改用 all 全网搜索" : undefined,
  };
}

/**
 * 搜索入口(全网聚合):
 * - 第一梯队:必应+百度并行,按相关性交错合并去重
 * - 第二梯队(双双空结果才触发):搜狗+Yahoo 并行兜底。
 *   搜狗收录微信公众号文章(中文内容独有优势);Yahoo 在海外网络生效,
 *   国内网络 6s 超时后被 allSettled 静默吞掉,不阻塞。
 */
async function searchWeb(query: string, num: number) {
  const [bingR, baiduR] = await Promise.allSettled([
    searchBing(query, num),
    searchBaidu(query, num),
  ]);
  if (bingR.status === "rejected") console.warn("[Tools] Bing 搜索失败:", bingR.reason);
  if (baiduR.status === "rejected") console.warn("[Tools] 百度搜索失败:", baiduR.reason);
  const bing = bingR.status === "fulfilled" ? bingR.value : [];
  const baidu = baiduR.status === "fulfilled" ? baiduR.value : [];

  // 交错合并:两引擎交替各取一条,保证两边都有代表;再按原序补足
  const merged: { title: string; snippet: string; url: string }[] = [];
  const seen = new Set<string>();
  const push = (r: { title: string; snippet: string; url: string }) => {
    // 百度链接是 baidu.com/link?url= 跳转链接,同一真实页面会生成不同跳转串,
    // 用标题(截断)做去重 key 更稳
    const key = r.title.slice(0, 60);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(r);
  };
  for (let i = 0; i < Math.max(bing.length, baidu.length); i++) {
    if (bing[i]) push(bing[i]);
    if (baidu[i]) push(baidu[i]);
  }
  let items = merged;
  if (items.length === 0) {
    // 第二梯队:搜狗+Yahoo 并行,谁通算谁的
    const [sogouR, yahooR] = await Promise.allSettled([
      searchSogou(query, num),
      searchYahoo(query, num),
    ]);
    if (sogouR.status === "rejected") console.warn("[Tools] 搜狗兜底失败:", sogouR.reason);
    if (yahooR.status === "rejected") console.warn("[Tools] Yahoo 兜底失败:", yahooR.reason);
    const sogou = sogouR.status === "fulfilled" ? sogouR.value : [];
    const yahoo = yahooR.status === "fulfilled" ? yahooR.value : [];
    const fallbackSeen = new Set<string>();
    items = [...sogou, ...yahoo].filter((r) => {
      const key = r.title.slice(0, 60);
      if (!key || fallbackSeen.has(key)) return false;
      fallbackSeen.add(key);
      return true;
    });
  }
  return items;
}

/**
 * 百度直连搜索(桌面版结果页)。
 * 链接是 baidu.com/link?url= 跳转链接,阅读时 smartCrawl 会跟随 302 到真实页面。
 * 命中反爬(安全验证页)时抛错由调用方降级。
 */
async function searchBaidu(query: string, num: number) {
  const url =
    "https://www.baidu.com/s?wd=" +
    encodeURIComponent(query) +
    "&rn=" + Math.min(num, 20) +
    "&ie=utf-8";
  const html = await fetchHtml(url);
  // 反爬拦截:返回验证页而非结果页
  if (html.includes("百度安全验证") || html.includes("wappass.baidu.com")) {
    throw new Error("百度触发安全验证");
  }

  const results: { title: string; snippet: string; url: string }[] = [];
  // 结果块:<h3><a href>标题</a></h3> + 后续正文(直到下一个 h3)
  const blockRe =
    /<h3[^>]*>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>([\s\S]*?)(?=<h3[\s>]|<div[^>]*id="page"|<\/body)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < num) {
    const href = m[1];
    const title = stripHtml(m[2]).slice(0, 100);
    // 跳过百度自家产品入口(新闻/视频 tab 等)与推广位
    if (!title) continue;
    if (!/^https?:\/\//.test(href)) continue;
    if (href.includes("baidu.com/s?") || href.includes("baidu.com/baidu?")) continue;
    if (m[3].includes('class="bdshare"') || m[3].includes("biaoqian")) continue;
    const snippet = stripHtml(m[3]).slice(0, 200);
    results.push({ title, url: href, snippet });
  }
  return results;
}

/** 知乎/小红书链接归一化:去掉追踪参数,保留规范 URL */
function normalizeBaiduOrZhihuLink(url: string): string {
  try {
    const u = new URL(url);
    // 知乎回答/文章链接带 utm 等追踪参数,去掉可减少阅读时的无效跳转
    if (u.hostname.endsWith("zhihu.com") || u.hostname.endsWith("xiaohongshu.com")) {
      for (const key of [...u.searchParams.keys()]) {
        if (/^(utm_|share_|source|mid|_xsfd|xsec)/i.test(key)) u.searchParams.delete(key);
      }
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

/**
 * 搜狗网页搜索。链接是 /link?url= 相对跳转(需补全域名),阅读时 smartCrawl 跟随 302。
 * 特色:收录微信公众号文章(DDG/Bing 均无此能力)。
 */
async function searchSogou(query: string, num: number) {
  const url = "https://www.sogou.com/web?query=" + encodeURIComponent(query);
  const html = await fetchHtml(url);
  if (html.includes("antispider") || html.includes("请输入验证码")) {
    throw new Error("搜狗触发验证码");
  }

  const results: { title: string; snippet: string; url: string }[] = [];
  const blockRe =
    /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>([\s\S]*?)(?=<h3[\s>]|<\/body)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < num) {
    let href = m[1];
    if (href.startsWith("//")) href = "https:" + href;
    else if (href.startsWith("/")) href = "https://www.sogou.com" + href;
    const title = stripHtml(m[2]).slice(0, 100);
    if (!title || !/^https?:\/\//.test(href)) continue;
    const snippetM = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title,
      url: href,
      snippet: snippetM ? stripHtml(snippetM[1]).slice(0, 200) : "",
    });
  }
  return results;
}

/** 搜狗微信搜索(微信公众号文章,独家来源) */
async function searchSogouWeixin(query: string, num: number) {
  const url = "https://weixin.sogou.com/weixin?type=2&query=" + encodeURIComponent(query);
  const html = await fetchHtml(url);
  if (html.includes("antispider") || html.includes("请输入验证码")) {
    throw new Error("搜狗微信触发验证码");
  }

  const results: { title: string; snippet: string; url: string }[] = [];
  const blockRe =
    /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>([\s\S]*?)(?=<h3[\s>]|<\/body)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < num) {
    let href = m[1];
    if (href.startsWith("//")) href = "https:" + href;
    else if (href.startsWith("/")) href = "https://weixin.sogou.com" + href;
    const title = stripHtml(m[2]).slice(0, 100);
    if (!title || !/^https?:\/\//.test(href)) continue;
    const snippetM = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title,
      url: href,
      snippet: snippetM ? stripHtml(snippetM[1]).slice(0, 200) : "",
    });
  }
  return results;
}

/**
 * Yahoo 搜索(海外网络生效;国内网络超时,被 allSettled 静默吞掉不阻塞)。
 * 用较短超时,减少兜底路径的整体等待。
 */
async function searchYahoo(query: string, num: number) {
  const url =
    "https://search.yahoo.com/search?p=" + encodeURIComponent(query) + "&n=" + Math.min(num, 20);
  const html = await fetchHtml(url, 6000);

  const results: { title: string; snippet: string; url: string }[] = [];
  // Yahoo 结果块:<div class="algo ..."><h3><a href>标题</a></h3>...<p>摘要</p></div>
  const blockRe =
    /<div[^>]*class="[^"]*\balgo\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\balgo\b|<\/body)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < num) {
    const block = m[1];
    const titleM = block.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    const title = stripHtml(titleM[2]).slice(0, 100);
    if (!title) continue;
    const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title,
      url: titleM[1],
      snippet: snippetM ? stripHtml(snippetM[1]).slice(0, 200) : "",
    });
  }
  return results;
}

async function searchBing(query: string, num: number) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${num}&setlang=zh-hans`;
  const html = await fetchHtml(url);
  const results: { title: string; snippet: string; url: string }[] = [];
  const blockRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < num) {
    const block = m[0];
    const titleM = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleM) continue;
    const snippetM = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title: stripHtml(titleM[2]).slice(0, 100),
      url: titleM[1],
      snippet: snippetM ? stripHtml(snippetM[1]).slice(0, 200) : "",
    });
  }
  return results;
}

async function fetchHtml(url: string, timeoutMs = 12000): Promise<string> {
  const response = await guardedFetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return readTextWithCap(response);
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&(?:ldquo|rdquo|lsquo|rsquo|mdash|ndash|hellip|rarr|middot|bull);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
/* ════════════════════════════════════════════════════════
 * GitHub 工具(公共 REST API,无需登录;可选 token 提升限额)
 * ════════════════════════════════════════════════════════ */

/** GitHub API 请求封装:统一 UA/认证/超时/错误提取 */
async function ghFetch(path: string, token?: string, raw = false): Promise<unknown> {
  const headers: Record<string, string> = {
    "User-Agent": "ai-platform-tools",
    Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
  };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await guardedFetch("https://api.github.com" + path, {
    headers,
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0")) {
    throw new Error("GitHub API 限额用尽(未认证 60 次/小时),可在设置里配置 GitHub Token 提升到 5000 次/小时");
  }
  if (res.status === 404) throw new Error("GitHub 资源不存在:" + path);
  if (!res.ok) throw new Error("GitHub API HTTP " + res.status);
  if (raw) return readTextWithCap(res, 512 * 1024);
  return res.json();
}

/** 工具:GitHub 查询。返回体刻意精简(只留模型需要的字段,省 token) */
async function toolGithub(
  args: { action: string; query: string; repo: string; path: string; per_page?: number },
  token?: string
) {
  const perPage = Math.min(Math.max(Number(args.per_page) || 5, 1), 10);
  const repoOk = /^[\w.-]+\/[\w.-]+$/.test(args.repo);

  switch (args.action) {
    case "search_repos": {
      if (!args.query) throw new Error("search_repos 需要 query 参数");
      const data = (await ghFetch(
        "/search/repositories?q=" + encodeURIComponent(args.query) +
        "&sort=stars&order=desc&per_page=" + perPage,
        token
      )) as { items?: Array<Record<string, unknown>> };
      return {
        total: (data as { total_count?: number }).total_count,
        repos: (data.items ?? []).map((r) => ({
          name: r.full_name,
          stars: r.stargazers_count,
          language: r.language,
          description: typeof r.description === "string" ? r.description.slice(0, 150) : "",
          url: r.html_url,
          updated: r.pushed_at,
        })),
      };
    }

    case "repo_info": {
      if (!repoOk) throw new Error("repo_info 需要 repo 参数(owner/name 格式)");
      const r = (await ghFetch("/repos/" + args.repo, token)) as Record<string, unknown>;
      // README 摘要(失败不影响主信息)
      let readme: string | undefined;
      try {
        const raw = (await ghFetch("/repos/" + args.repo + "/readme", token, true)) as string;
        readme = raw.slice(0, 2500);
      } catch {
        /* 私有/无 README,忽略 */
      }
      return {
        name: r.full_name,
        stars: r.stargazers_count,
        forks: r.forks_count,
        openIssues: r.open_issues_count,
        language: r.language,
        license: (r.license as Record<string, unknown> | null)?.spdx_id,
        description: typeof r.description === "string" ? r.description.slice(0, 200) : "",
        topics: r.topics,
        homepage: r.homepage,
        created: r.created_at,
        updated: r.pushed_at,
        defaultBranch: r.default_branch,
        readme,
      };
    }

    case "read_file": {
      if (!repoOk) throw new Error("read_file 需要 repo 参数(owner/name 格式)");
      if (!args.path) throw new Error("read_file 需要 path 参数");
      // 二进制扩展名预检:先拒绝再请求,避免白下载最多 512KB 的不可用内容
      if (/\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|woff2?)$/i.test(args.path)) {
        throw new Error("二进制文件不支持读取:" + args.path);
      }
      const raw = (await ghFetch(
        "/repos/" + args.repo + "/contents/" + args.path.split("/").map(encodeURIComponent).join("/"),
        token,
        true
      )) as string;
      return { repo: args.repo, path: args.path, size: raw.length, content: raw.slice(0, 6000) };
    }

    case "search_issues": {
      if (!repoOk) throw new Error("search_issues 需要 repo 参数(owner/name 格式)");
      const q = "repo:" + args.repo + " " + (args.query || "");
      const data = (await ghFetch(
        "/search/issues?q=" + encodeURIComponent(q) + "&sort=updated&per_page=" + perPage,
        token
      )) as { total_count?: number; items?: Array<Record<string, unknown>> };
      return {
        total: data.total_count,
        issues: (data.items ?? []).map((i) => ({
          number: i.number,
          state: i.state,
          title: typeof i.title === "string" ? i.title.slice(0, 100) : "",
          url: i.html_url,
          comments: i.comments,
          updatedAt: i.updated_at,
        })),
      };
    }

    case "commits": {
      if (!repoOk) throw new Error("commits 需要 repo 参数(owner/name 格式)");
      const list = (await ghFetch(
        "/repos/" + args.repo + "/commits?per_page=" + perPage,
        token
      )) as Array<Record<string, unknown>>;
      return {
        commits: (Array.isArray(list) ? list : []).map((c) => {
          const commit = c.commit as Record<string, unknown> | undefined;
          return {
            sha: typeof c.sha === "string" ? c.sha.slice(0, 7) : "",
            message: typeof commit?.message === "string" ? commit.message.split("\n")[0].slice(0, 100) : "",
            date: (commit?.author as Record<string, unknown> | undefined)?.date,
            author: (commit?.author as Record<string, unknown> | undefined)?.name,
          };
        }),
      };
    }

    default:
      throw new Error("未知 action: " + args.action + "(可选 search_repos/repo_info/read_file/search_issues/commits)");
  }
}

/**
 * 工具：获取网页内容
 * 直接调用 smartCrawl(此处是 Node 服务端环境,相对路径 fetch 会抛
 * "Failed to parse URL",必须走库函数而非 HTTP 自调用)
 */
async function toolFetchWebpage(url: string, maxLength: number) {
  const result = await smartCrawl(url, { maxContentLength: maxLength });
  return {
    url,
    title: result.title,
    content: result.content,
    stats: result.stats,
  };
}

/**
 * 工具：搜索并阅读(多个页面并行阅读,总耗时约等于最慢的一个)
 */
async function toolSearchAndRead(query: string, readTop: number, site?: string) {
  // 1. 先搜索(跳过 web_search 内置的自动全文抓取,避免下面重复阅读同一批页面)
  const searchResult = await toolWebSearch(query, readTop, { autoFetch: false, site });

  // 2. 并行阅读前 N 个结果(单页失败不影响其余)
  const targets = searchResult.results
    .slice(0, readTop)
    .filter((item) => item.url && item.url.startsWith("http"));

  const settled = await Promise.allSettled(
    targets.map((item) => toolFetchWebpage(item.url, 2500))
  );

  const readings: unknown[] = settled.map((s, i) =>
    s.status === "fulfilled" ? s.value : { url: targets[i].url, error: "Failed to read" }
  );

  return {
    query,
    searchResults: searchResult.results,
    readings,
  };
}

/**
 * 工具：AI 自主优化提示词并生成图片
 */
async function toolGenerateImage(
  prompt: string,
  style: string,
  opts: { imageApiKey?: string } = {}
) {
  // AI 自动优化提示词
  const stylePrompts: Record<string, string> = {
    realistic: "photorealistic, high detail, 8k, professional photography",
    artistic: "digital art, artistic style, vibrant colors, creative composition",
    cartoon: "cartoon style, cute, colorful, clean lines, illustration",
    anime: "anime style, detailed, studio ghibli inspired, beautiful lighting",
    photographic: "professional photograph, sharp focus, natural lighting, DSLR quality",
  };

  const enhancedPrompt = `${prompt}, ${stylePrompts[style] || stylePrompts.realistic}`;

  // 调用图片生成 API
  // 优先从各 provider 专用的 env var 读取(FLUX_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / KUAISHOU_API_KEY / DASHSCOPE_API_KEY)
  // 兜底用 IMAGE_API_KEY / DEFAULT_IMAGE_API_KEY(兼容旧配置)
  // 注意: DEFAULT_IMAGE_API 是 provider 名称(如 "flux"),不是 API key,不应作为 key 使用
  // 优先用前端传来的 imageApiKey(用户在设置中配置的真实 key),其次 fallback env
  const apiKey =
    opts.imageApiKey ||
    process.env.FLUX_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.KUAISHOU_API_KEY ||
    process.env.DASHSCOPE_API_KEY ||
    process.env.IMAGE_API_KEY ||
    process.env.DEFAULT_IMAGE_API_KEY ||
    "";
  if (!apiKey) {
    throw new Error("No image API key configured. Please set your image API key in the Settings page.");
  }

  const response = await guardedFetch("https://api.qnaigc.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-image-2",
      prompt: enhancedPrompt,
      n: 1,
      size: "1024x1024",
    }),
  });

  if (!response.ok) {
    await response.text().catch(() => null); // 读完释放连接,不回显上游错误内容
    throw new Error(`Image generation failed: ${response.status}`);
  }

  const data = await response.json();
  const image = data.data?.[0];

  return {
    originalPrompt: prompt,
    enhancedPrompt,
    style,
    imageUrl: image?.url || (image?.b64_json ? `data:image/png;base64,${image.b64_json}` : null),
  };
}

/**
 * 将工具定义转换为 OpenAI function 格式
 */
/**
 * 将工具定义转换为 OpenAI / GPT-5 兼容的 tools 格式
 * - strict: true: 强制模型严格按 JSON Schema 输出参数,减少无效调用(OpenAI 推荐 GPT-5 必开)
 * - type: "function": OpenAI 标准格式,GPT-5 原生支持
 */
export function toolsToOpenAIFunctions(tools: Tool[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    },
  }));
}

/** 安全解析模型返回的工具参数 JSON(模型偶尔会输出不合法 JSON,不应让整个流崩掉) */
export function safeParseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 从 AI 响应中解析工具调用
 * 支持 OpenAI 格式的 function_call / tool_calls
 */
export function parseToolCalls(response: unknown): ToolCall[] {
  const resp = response as Record<string, unknown>;
  const choices = resp.choices as Array<Record<string, unknown>> | undefined;
  if (!choices?.[0]) return [];

  const message = choices[0].message as Record<string, unknown> | undefined;
  if (!message) return [];

  const toolCalls: ToolCall[] = [];

  // OpenAI format: message.tool_calls
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      const fn = tc.function as Record<string, unknown>;
      toolCalls.push({
        id: tc.id as string,
        name: fn.name as string,
        arguments: safeParseArguments(fn.arguments),
      });
    }
  }

  // Legacy format: message.function_call
  if (message.function_call && !toolCalls.length) {
    const fc = message.function_call as Record<string, string>;
    toolCalls.push({
      id: `call_${Date.now()}`,
      name: fc.name,
      arguments: safeParseArguments(fc.arguments),
    });
  }

  return toolCalls;
}
