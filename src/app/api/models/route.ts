export const dynamic = "force-dynamic";

interface ModelOption {
  id: string;
  label: string;
  group: "cloud" | "local" | "top" | "budget";
  /** 默认网关(OpenAI 兼容 base url);前端选模型时自动切换 */
  gateway?: string;
}

const CLOUD_MODELS: ModelOption[] = [
  // 🏆 顶级模型（七牛云聚合 + DeepSeek 官方）
  { id: "claude-sonnet-5", label: "Claude 5 Sonnet", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "claude-opus-5", label: "Claude 5 Opus", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "claude-fable-5", label: "Claude 5 Fable", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "grok-4.5", label: "Grok 4.5", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "qwen3.8-max", label: "Qwen3.8 Max", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "deepseek-reasoner", label: "DeepSeek R1", group: "top", gateway: "https://api.deepseek.com/v1" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", group: "top", gateway: "https://api.deepseek.com/v1" },
  { id: "openai/gpt-4.1", label: "GPT-4.1", group: "top", gateway: "https://api.qnaigc.com/v1" },
  { id: "qwen3-235b-a22b", label: "Qwen3 235B", group: "top", gateway: "https://api.qnaigc.com/v1" },
  // 💰 性价比模型
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", group: "budget", gateway: "https://api.qnaigc.com/v1" },
  { id: "deepseek-chat", label: "DeepSeek Chat V3", group: "budget", gateway: "https://api.deepseek.com/v1" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", group: "budget", gateway: "https://api.deepseek.com/v1" },
  { id: "glm-4.7-flash", label: "GLM-4.7 Flash", group: "budget", gateway: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "qwen3-30b-a3b", label: "Qwen3 30B", group: "budget", gateway: "https://api.qnaigc.com/v1" },
  { id: "kimi-k2", label: "Kimi K2", group: "budget", gateway: "https://api.moonshot.cn/v1" },
  { id: "mimo-v2.5", label: "MiMo V2.5", group: "budget", gateway: "https://api.xiaomimimo.com/v1" },
  { id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", group: "budget", gateway: "https://api.xiaomimimo.com/v1" },
];

/** 模型列表 = 静态云端模型 + 本地 Ollama 已装模型 */
export async function GET() {
  let local: ModelOption[] = [];
  try {
    // 服务端固定地址,非用户可控,无需 SSRF 校验
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models)) {
        const names: string[] = [];
        for (const m of data.models as Array<{ name?: unknown }>) {
          if (typeof m?.name === "string") names.push(m.name);
        }
        local = names.map((name) => ({
          id: `ollama/${name}`,
          label: name,
          group: "local" as const,
        }));
      }
    }
  } catch {
    // Ollama 未启动,只返回云端模型
  }

  return Response.json({ models: [...CLOUD_MODELS, ...local] });
}
