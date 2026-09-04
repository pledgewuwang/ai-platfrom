/** 文本工具(复刻自 ai-novel-writer,写作台专用) */

/** 统计字数:去除空白后的 Unicode 码点数(中文友好) */
export function countWords(text: string): number {
  return [...text.replace(/\s/g, "")].length;
}

/** 取文本尾部 n 个码点 */
export function tail(text: string, n: number): string {
  const cps = [...text];
  return cps.length <= n ? text : cps.slice(-n).join("");
}

/** 取文本开头 n 个码点 */
export function head(text: string, n: number): string {
  const cps = [...text];
  return cps.length <= n ? text : cps.slice(0, n).join("");
}

/** 生成前端消息 ID(不用 nanoid 减少依赖面) */
let seq = 0;
export function localId(prefix = "m"): string {
  seq += 1;
  return prefix + "_" + Date.now().toString(36) + "_" + seq;
}

/**
 * 轻量去除 Markdown 标记(聊天回复插入正文用):
 * 标题符 / 加粗 / 斜体 / 行内代码反引号 / 引用符。列表、链接等保持原样。
 */
export function stripMarkdownLight(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^>\s?/gm, "");
}
