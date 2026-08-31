export const dynamic = "force-dynamic";

interface ModelOption {
  id: string;
  label: string;
  group: "cloud" | "local";
}

const CLOUD_MODELS: ModelOption[] = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", group: "cloud" },
  { id: "openai/gpt-4o", label: "GPT-4o", group: "cloud" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", group: "cloud" },
  { id: "claude-opus-5", label: "Claude Opus 5", group: "cloud" },
  { id: "deepseek-chat", label: "DeepSeek", group: "cloud" },
  { id: "glm-4.6", label: "GLM-4.6", group: "cloud" },
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
