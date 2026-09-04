/**
 * 共享模型供应商配置(对话平台与写作台共用)
 *
 * - 对话设置面板与写作台「模型设置」都从这里取提供商目录
 * - 所有 AI 调用统一走 lib/cloud-chat 的 API 规则:
 *   https + 域名白名单(CHAT_API_ALLOWED_HOSTS) + 内网地址拦截 + 按域名分 Key
 *   —— 写作台与对话平台共用同一套配置(chatApiUrl / chatProviderKeys / chatModel)
 */

export interface ChatProviderDef {
  id: string;
  label: string;
  /** OpenAI 兼容 base url */
  url: string;
  note?: string;
}

export const CHAT_PROVIDERS: ChatProviderDef[] = [
  { id: "qiniu", label: "七牛云 (推荐)", url: "https://api.qnaigc.com/v1" },
  { id: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com/v1" },
  { id: "zhipu", label: "智谱华章 (GLM)", url: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "moonshot", label: "月之暗面 (Kimi)", url: "https://api.moonshot.cn/v1" },
  { id: "minimax", label: "蚂蚁百灵 (MiniMax)", url: "https://api.minimax.chat/v1" },
  { id: "mimo", label: "小米 MIMO", url: "https://api.xiaomimimo.com/v1" },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic (Claude)", url: "https://api.anthropic.com/v1" },
  { id: "dashscope", label: "阿里云 DashScope (通义)", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "siliconflow", label: "SiliconFlow (硅基流动)", url: "https://api.siliconflow.cn/v1" },
];

/** 按 id 查提供商定义 */
export function providerDef(id: string): ChatProviderDef {
  return CHAT_PROVIDERS.find((p) => p.id === id) ?? CHAT_PROVIDERS[0];
}
