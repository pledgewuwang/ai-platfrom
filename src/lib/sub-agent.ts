/**
 * 子 Agent 分工模式
 *
 * 概念:主对话把一个复杂问题拆成 N 个子任务,每个子任务交给一个 worker
 * 独立调用(可不同)模型,结果汇总后由主对话生成最终答复。
 *
 * 设计目标:
 *  - 子 Agent 可指定自己的 modelName / maxTokens(支持"降级模型":
 *    主力贵模型处理关键子任务,便宜小模型处理机械子任务)
 *  - 子 Agent 温度固定 0.3(分工输出要确定、简短,不跟随主对话/编程模式的温度)
 *  - 子 Agent 全部独立,允许互相不串扰(token 不混算)
 *  - 默认并行执行,主对话等待 N 个 worker 全部完成(或超时)
 *  - 子 Agent 失败不阻塞其他,失败信息在最终汇总里标出
 *
 * 与现有 tool 系统独立:这里是预先定义在请求里的"分工"而非模型主动调用的工具。
 */

export interface SubAgent {
  /** 唯一 id(在同一次请求里唯一) */
  id: string;
  /** 简短角色名,如 "researcher" / "summarizer" */
  role: string;
  /** 子 Agent 的系统提示词(短而聚焦) */
  systemPrompt: string;
  /** 用户问题 */
  userMessage: string;
  /** 可选:指定子 Agent 用的模型名;不传则用主对话的模型 */
  modelName?: string;
  /** 可选:子 Agent 单独的 max_tokens 上限(默认 800) */
  maxTokens?: number;
  /** 可选:超时毫秒(默认 30000) */
  timeoutMs?: number;
}

export interface SubAgentResult {
  id: string;
  role: string;
  /** 子 Agent 的最终文本输出 */
  output: string;
  /** 使用的模型名(便于排查) */
  modelUsed: string;
  /** 耗时 ms */
  durationMs: number;
  /** 失败时为错误信息,成功时为空 */
  error?: string;
}

/**
 * 并行执行所有子 Agent。
 * 任一失败不影响其他;返回顺序与传入顺序一致(便于主对话按角色引用)。
 */
export async function runSubAgents(
  openaiChatFn: (params: {
    model: string;
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    temperature?: number;
    max_tokens?: number;
    signal?: AbortSignal;
  }) => Promise<{ content: string }>,
  agents: SubAgent[],
  /** 主对话的 fallback model,子 Agent 未指定 modelName 时使用 */
  defaultModel: string
): Promise<SubAgentResult[]> {
  if (agents.length === 0) return [];

  const tasks = agents.map(async (agent): Promise<SubAgentResult> => {
    const model = agent.modelName || defaultModel;
    const start = Date.now();
    const timeoutMs = agent.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await openaiChatFn({
        model,
        // 子 Agent 温度固定 0.3:分工输出要确定、简短,不跟随主对话/编程模式
        temperature: 0.3,
        // 与 formatSubAgentResults 的 maxCharsPerAgent(1500 字符)匹配,
        // 避免生成远多于注入限度的冗余 token
        max_tokens: agent.maxTokens ?? 800,
        signal: controller.signal,
        messages: [
          {
            role: "system",
            content: `${agent.systemPrompt}\n\n输出要求:直接给出结论要点,不要复述问题、不要解释推理过程,保持简洁。`,
          },
          { role: "user", content: agent.userMessage },
        ],
      });
      if (!result.content || !result.content.trim()) {
        return {
          id: agent.id,
          role: agent.role,
          output: "",
          modelUsed: model,
          durationMs: Date.now() - start,
          error: "子 Agent 返回空内容",
        };
      }
      return {
        id: agent.id,
        role: agent.role,
        output: result.content,
        modelUsed: model,
        durationMs: Date.now() - start,
      };
    } catch (e: unknown) {
      const message = controller.signal.aborted
        ? `子 Agent 超时(>${timeoutMs}ms)`
        : e instanceof Error
          ? e.message
          : String(e);
      return {
        id: agent.id,
        role: agent.role,
        output: "",
        modelUsed: model,
        durationMs: Date.now() - start,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  });

  return Promise.all(tasks);
}

/**
 * 把子 Agent 的结果格式化成可注入主对话上下文的文本。
 * 紧凑形式,带 token 控制:
 *   - 每人输出截断到 maxCharsPerAgent
 *   - 失败的角色明确标记 error
 *   - 最终块的总字符上限 = maxTotalChars
 */
export function formatSubAgentResults(
  results: SubAgentResult[],
  opts: { maxCharsPerAgent?: number; maxTotalChars?: number } = {}
): string {
  if (results.length === 0) return "";
  const maxPer = opts.maxCharsPerAgent ?? 1500;
  const maxTotal = opts.maxTotalChars ?? 6000;

  const lines: string[] = [];
  let total = 0;
  for (const r of results) {
    const head = `[${r.role}${r.error ? " · 失败" : ""}]`;
    const body = r.error ? `(error) ${r.error}` : r.output.slice(0, maxPer);
    const line = `${head}\n${body}`;
    if (total + line.length > maxTotal) {
      lines.push(`... (剩余 ${results.length - lines.length} 个结果被截断以省 token)`);
      break;
    }
    lines.push(line);
    total += line.length + 2;
  }
  return lines.join("\n\n");
}