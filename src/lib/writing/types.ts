/** 写作台类型定义(复刻自 ai-novel-writer) */

/** 章节元数据(列表用,不含正文) */
export type ChapterMeta = {
  id: string;
  title: string;
  order: number;
  wordCount: number;
  createdAt: number;
  updatedAt: number;
};

/** 完整章节 */
export type Chapter = ChapterMeta & { content: string };

/** 聊天消息(前端展示用) */
export type ChatMsg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 本次回答是否注入了分级记忆 */
  usedMemory?: boolean;
  failed?: boolean;
};

/** 写作动作 */
export type WritingAction = "continue" | "polish" | "expand" | "shorten" | "outline" | "deai";

/** 编辑器选区状态 */
export type EditorSelection = {
  start: number;
  end: number;
  selectedText: string;
  beforeTail: string;
  afterHead: string;
};

/** 写作台 SSE 事件协议 */
export type SseEvent =
  | { type: "memory"; text: string }
  | { type: "meta"; action: WritingAction }
  | { type: "delta"; content: string }
  | { type: "done" }
  | { type: "error"; message: string };
