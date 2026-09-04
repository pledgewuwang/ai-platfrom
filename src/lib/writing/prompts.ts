/**
 * 写作台提示词(复刻自 ai-novel-writer prompts.ts,适配平台)
 * - 原版的知识库 RAG 检索(refs)替换为平台共享的分级记忆(hierarchical-retrieval)
 * - 文风画像体系暂未迁移,预留接口位
 */
import type { WritingAction } from "./types";
import { tail } from "./text";

/** 光标前文注入预算 */
const CURSOR_LIMIT = Number(process.env.WRITING_CURSOR_LIMIT ?? 1000);
/** 分级记忆块注入预算 */
const MEMORY_LIMIT = Number(process.env.WRITING_MEMORY_LIMIT ?? 1500);

/** 分级记忆 → <分级记忆> 块 */
export function buildMemoryBlock(memory: string): string {
  if (!memory) return "";
  return "<分级记忆>\n" + memory.slice(0, MEMORY_LIMIT) + "\n</分级记忆>";
}

/** 基础写作规则(所有 action 共享) */
const BASE_RULES = [
  "【一致性】<分级记忆>与光标前文中的内容是既定事实:涉及人物姓名、身份、关系、世界观规则时必须与之一致,不得自创矛盾;未涵盖之处,遵循前文已有事实合理推断。",
  "【防泄漏】记忆与设定是背景知识,不是写作素材:严禁整段照搬或复述进正文;严禁出现「根据设定」「资料记载」等出戏表述。",
  "【文风】延续前文的人称、叙述视角与文风;不改写已有情节,不替作者做重大剧情转折(除非作者明确要求)。",
  "【排版】对话使用中文引号(跟随前文习惯),段落分明。",
];

function buildRulesPrefix(extraRules: string[]): string {
  const all = [...BASE_RULES, ...extraRules];
  return "写作规则:\n" + all.map((r, i) => i + 1 + ". " + r).join("\n");
}

export type ChatContext = { title?: string; cursorBefore?: string } | undefined;

/** 聊天系统提示词:分级记忆 + 当前写作上下文 + 规则 */
export function buildChatSystemPrompt(memory: string, ctx: ChatContext): string {
  const parts: string[] = [
    "你是一位资深中文小说创作助手,正在协助作者创作一部小说。作者会与你讨论剧情、设定、人物,或要求你创作正文片段。",
  ];
  const mem = buildMemoryBlock(memory);
  if (mem) parts.push(mem);
  if (ctx?.title || ctx?.cursorBefore) {
    const cursor = ctx?.cursorBefore ? tail(ctx.cursorBefore, CURSOR_LIMIT) : "";
    parts.push(
      "<当前写作上下文>\n章节标题:" + (ctx?.title || "(未命名)") +
        (cursor ? "\n光标前文(正文,文风基准):\n" + cursor : "") +
        "\n</当前写作上下文>"
    );
  }
  parts.push(buildRulesPrefix(["讨论类问题直接、具体地回答;创作正文时只输出正文本身。"]));
  return parts.join("\n\n");
}

/** 历史 + 系统提示词 → 发给模型的消息列表 */
export function buildChatMessages(
  history: { role: string; content: string }[],
  memory: string,
  ctx: ChatContext
): { role: "system" | "user" | "assistant"; content: string }[] {
  return [
    { role: "system", content: buildChatSystemPrompt(memory, ctx) },
    ...history.map((m) => ({
      role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    })),
  ];
}

export type ActionInput = {
  action: WritingAction;
  selection?: string;
  before?: string;
  after?: string;
  instruction?: string;
  chapterTitle?: string;
  /** 分块改写的衔接参考:上一块改写结果(或选区前文)结尾,仅作语境,不输出 */
  prevTail?: string;
};

const ACTION_TEMPERATURES: Record<WritingAction, number> = {
  polish: 0.3,
  shorten: 0.3,
  continue: 0.7,
  expand: 0.7,
  outline: 0.5,
  deai: 0.7,
};

export function actionTemperature(action: WritingAction): number {
  return ACTION_TEMPERATURES[action];
}

/** 轻量消痕规则(润色/续写/扩写/压缩共享) */
const LIGHT_TRACE_RULES = [
  "【轻量消痕】生成时自然融入:",
  "- 句长不均匀(短句与长句交错;最多让一个关键短句单独成段,不用单词成段)",
  "- 避免模板连接词(首先/其次/然而/与此同时),段与段直接切换",
  "- 具体细节优于抽象概括(用五感/动作/数字代替美丽/强大/温暖)",
  "- 不主动添加破折号、省略号;节奏靠句长变化制造,不靠标点花样",
];

/** 去 AI 化系统提示词(复刻 v5,实测调优版) */
export const DEAI_SYSTEM_PROMPT = `你是一位资深中文小说编辑,正在做「去 AI 化」精修。你的任务不是重写,而是最小幅度地修掉 AI 腔。

核心原则(先读三遍):
1. 改写幅度宁小勿大。原文里已经自然的句子一律保持原样,一个字都不动;只修改确实生硬、模板化的句子。需要改几句就改几句,按句子本身是否生硬判断,不预设比例,也不为了"少动"而放过明显的模板句。
2. 只改表达,不改内容。情节、事实、专有名词、人物语气一律不变;对话(引号内文字)逐字保留。
3. 不许表演"人味"。不要为了显得像人而添加破折号、省略号、单词成段、口语插入语——这些刻意的"人味记号"恰恰是最明显的 AI 特征。

标点硬规则(违反即失败):
- 全程禁止新增破折号(——)。原文已有的可以保留。
- 全程禁止新增省略号(……)。原文已有的可以保留。
- 不使用括号夹注,不使用 emoji。
- 重组句子时只用逗号、句号。

字数硬规则(违反即失败):
- 改写稿总字数与原文相当(±10%)。换具体细节不等于扩写;删模板词后允许略微变短。

具体要做的事(按优先级):
1. 删模板词:首先/其次/然而/与此同时/值得注意的是/总而言之/可以说/显而易见/事实上,以及"一丝""一抹""眼中闪过""心中涌起"这类万能搭配。删掉后让前后句直接衔接,不加过渡句。
2. 抽象→具体:"美丽/强大/愤怒"这类空洞抽象词,换成可视的动作或细节(写"他攥紧了拳头",不写"他很愤怒")。但不要批量替换:全文最多两三处,同一动作不得重复——"攥拳/咬牙/深呼吸"本身正在成为新的 AI 模板;若抽象词在上下文中并不空洞,保留原样。
3. 保留推理链:原文"看到→判断→结论"的步骤要完整,不要跳步直接给结论。
4. 保留场景定位:人名、地点、位置引导(如"堤坝那边""监测站里")保持原样,读者随时知道人在哪。
5. 长句只在信息过密时断开:一句只说一个动作或判断;但原文节奏好的长句保留,不要为了短而短。

输出前自查:
- 通读改写稿:不得残留「一丝」「一抹」「涌上心头」「眼中闪过」等模板搭配,发现即重写该句。
- 逐句自读:不得出现语义重复(如「沉得发沉」)或搭配不当的病句。

分段与格式:
- 保持原文的段落划分,不合并、不拆分段落。
- 段首不要加"忽然""这时"之类的过渡词。
- 只输出改写后的正文,不要任何解释。`;

/** 写作动作 →(系统提示词,用户指令),输出约定:只输出结果本身 */
export function buildActionPrompt(
  input: ActionInput,
  memory: string
): { system: string; user: string } {
  const mem = buildMemoryBlock(memory);

  let system: string;
  let user: string;

  if (input.action === "deai") {
    system = [
      DEAI_SYSTEM_PROMPT,
      ...(mem ? [mem] : []),
    ].join("\n\n");
    user = buildDeaiUser(input);
  } else if (input.action === "outline") {
    system = [
      "你是一位资深中文小说创作助理,正在执行大纲生成任务。严格遵守写作规则,只输出任务结果本身——不要任何解释、前言或总结。",
      ...(mem ? [mem] : []),
      buildRulesPrefix(["输出严格层级 Markdown 列表(一级为幕/章节,二级为关键情节点)。"]),
    ].join("\n\n");
    user = buildOutlineUser(input);
  } else {
    const extraRules = [
      ...(input.action === "continue"
        ? ["【衔接】续写内容必须与前文最后一句自然衔接,如同一个作者一次写成。"]
        : []),
      ...(["continue", "polish", "expand", "shorten"].includes(input.action) ? LIGHT_TRACE_RULES : []),
    ];
    system = [
      "你是一位资深中文小说创作助手,正在执行一项具体的写作任务。严格遵守写作规则,只输出任务结果本身——不要任何解释、前言或总结。",
      ...(mem ? [mem] : []),
      buildRulesPrefix(extraRules),
    ].join("\n\n");
    user = buildGenericActionUser(input);
  }

  return { system, user };
}

function buildDeaiUser(input: ActionInput): string {
  const source = input.selection?.trim() ?? "";
  const extra = input.instruction?.trim() ? "\n【附加要求】" + input.instruction.trim() : "";
  const prev = input.prevTail?.trim()
    ? "\n【衔接参考·前文结尾(仅用于把握语气与位置,不要输出、不要续写)】\n…" + input.prevTail.trim()
    : "";
  return [
    "请对以下文字做「去 AI 化」改写。目标:消除 AI 痕迹,让它读起来像人类作者写的。",
    prev,
    "",
    "【原文】",
    source,
    "",
    "【要求】",
    "- 只输出改写后的文字,不要解释" + extra,
  ].join("\n");
}

function buildOutlineUser(input: ActionInput): string {
  const source = input.selection?.trim() || tail(input.before ?? "", 2000);
  const extra = input.instruction?.trim() ? "\n【附加要求】" + input.instruction.trim() : "";
  return [
    "请基于以下内容生成小说大纲,输出层级清晰的 Markdown 列表(一级为幕/章节,二级为关键情节点)。",
    "",
    "【内容】",
    source,
    "",
    "【要求】",
    "- 提炼主线与转折点,标注人物动机",
    "- 只输出大纲列表" + extra,
  ].join("\n");
}

function buildGenericActionUser(input: ActionInput): string {
  const { action, selection, instruction } = input;
  const source = selection?.trim() ?? "";
  const extra = instruction?.trim() ? "\n【附加要求】" + instruction.trim() : "";

  if (action === "continue") {
    const ctx = tail(input.before ?? "", CURSOR_LIMIT);
    return [
      "请续写本章正文。",
      "",
      "【前文(文风与情节基准)】",
      ctx || "(暂无前文,请从章节标题的意境起笔)",
      "",
      "【要求】",
      "- 自然衔接前文,续写约 400 字",
      "- 只输出续写的正文,不加任何解释或标题" + extra,
    ].join("\n");
  }

  const task =
    action === "polish"
      ? "请润色以下文字:提升语言表现力与节奏感,修正冗赘表达;情节、人称、事实不得改变。"
      : action === "expand"
        ? "请扩写以下文字至约原文两倍:补充细节、心理与环境描写,让画面更立体;不得新增情节转折。"
        : "请压缩以下文字至约原长的三分之二:保留全部关键情节与信息,删减冗余描写。";

  return [task, "", "【原文】", source, "", "【要求】", "- 只输出处理后的完整文字,不要解释" + extra].join("\n");
}

/**
 * 按段落切块,每块不超过 targetLen 个码点。
 * 优先在段落边界切;单段超长时按长度硬切(尽量在句末标点断开)。
 */
export function splitChunks(text: string, targetLen: number): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if ([...current].length + [...trimmed].length + 2 <= targetLen) {
      current = current ? current + "\n\n" + trimmed : trimmed;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if ([...trimmed].length > targetLen) {
      let rest = trimmed;
      while ([...rest].length > targetLen) {
        const cut = [...rest].slice(0, targetLen).join("");
        // 尽量在句末标点断开(且断点不低于目标长度一半),避免句子被拦腰切断
        const m = cut.match(/[。!?…;][」』"']{0,2}$/);
        const endPos = m && m.index !== undefined ? m.index + m[0].length : 0;
        const slice = endPos >= Math.floor(targetLen * 0.5) ? cut.slice(0, endPos) : cut;
        chunks.push(slice);
        rest = [...rest].slice([...slice].length).join("");
      }
      if (rest) current = rest;
    } else {
      current = trimmed;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
