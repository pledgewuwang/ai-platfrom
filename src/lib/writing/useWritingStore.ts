"use client";

/**
 * 写作台全局状态(复刻自 ai-novel-writer useWorkspace,适配平台)
 * 章节编辑/保存/选区/聊天/写作动作,数据走 /api/writing/*。
 */
import { create } from "zustand";
import { toast } from "sonner";
import type { ChapterMeta, ChatMsg, EditorSelection, WritingAction } from "./types";
import { localId } from "./text";

export type SaveState = "saved" | "dirty" | "saving" | "error";

export type ActionResult = {
  running: boolean;
  type: WritingAction | null;
  text: string;
  failed: boolean;
  /** 动作发起时记录的选区范围,用于「替换选中」 */
  range: { start: number; end: number } | null;
};

const EMPTY_SELECTION: EditorSelection = {
  start: 0,
  end: 0,
  selectedText: "",
  beforeTail: "",
  afterHead: "",
};

const EMPTY_ACTION: ActionResult = {
  running: false,
  type: null,
  text: "",
  failed: false,
  range: null,
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 800;

type WritingState = {
  chapters: ChapterMeta[];
  currentChapterId: string | null;
  title: string;
  content: string;
  selection: EditorSelection;
  saveState: SaveState;
  pendingCaret: number | null;
  chatMsgs: ChatMsg[];
  chatStreaming: boolean;
  action: ActionResult;

  init: () => Promise<void>;
  openChapter: (id: string) => Promise<void>;
  newChapter: () => Promise<void>;
  deleteChapter: (id: string) => Promise<void>;
  moveChapter: (id: string, dir: -1 | 1) => Promise<void>;
  setTitle: (title: string) => void;
  setContent: (content: string) => void;
  updateSelection: (sel: EditorSelection) => void;
  saveNow: () => Promise<void>;
  insertAtCursor: (text: string) => void;
  replaceRange: (text: string, range: { start: number; end: number }) => void;
  appendChat: (msg: ChatMsg) => void;
  patchLastAssistant: (patch: Partial<ChatMsg>) => void;
  setChatStreaming: (v: boolean) => void;
  clearChat: () => void;
  resetAction: () => void;
  patchAction: (patch: Partial<ActionResult>) => void;
};

/** 新建一条聊天消息的辅助函数 */
export function makeMsg(role: "user" | "assistant", content: string): ChatMsg {
  return { id: localId("msg"), role, content, failed: false };
}

export const useWritingStore = create<WritingState>((set, get) => {
  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void get().saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  return {
    chapters: [],
    currentChapterId: null,
    title: "",
    content: "",
    selection: EMPTY_SELECTION,
    saveState: "saved",
    pendingCaret: null,
    chatMsgs: [],
    chatStreaming: false,
    action: EMPTY_ACTION,

    init: async () => {
      try {
        const listRes = await fetch("/api/writing/chapters").then(
          (r) => r.json() as Promise<{ chapters: ChapterMeta[] }>
        );
        set({ chapters: listRes.chapters });
        if (listRes.chapters.length === 0) {
          await get().newChapter();
        } else {
          await get().openChapter(listRes.chapters[0].id);
        }
      } catch {
        toast.error("初始化失败:无法连接写作台服务,请刷新重试");
      }
    },

    openChapter: async (id) => {
      // 切换前冲刷未保存内容
      if (get().saveState !== "saved" && get().currentChapterId) {
        await get().saveNow();
      }
      try {
        const { chapter } = await fetch("/api/writing/chapters/" + id).then(
          (r) => r.json() as Promise<{ chapter: { title: string; content: string } }>
        );
        set({
          currentChapterId: id,
          title: chapter.title,
          content: chapter.content,
          saveState: "saved",
          selection: EMPTY_SELECTION,
          pendingCaret: null,
        });
      } catch {
        toast.error("打开章节失败");
      }
    },

    newChapter: async () => {
      if (get().saveState !== "saved") await get().saveNow();
      const n = get().chapters.length + 1;
      try {
        const { chapter } = await fetch("/api/writing/chapters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "第" + n + "章" }),
        }).then((r) => r.json() as Promise<{ chapter: ChapterMeta }>);
        set((s) => ({
          chapters: [...s.chapters, chapter],
          currentChapterId: chapter.id,
          title: chapter.title,
          content: "",
          saveState: "saved",
          selection: EMPTY_SELECTION,
        }));
      } catch {
        toast.error("新建章节失败");
      }
    },

    deleteChapter: async (id) => {
      const target = get().chapters.find((c) => c.id === id);
      if (!target) return;
      if (!window.confirm("确定删除「" + target.title + "」?此操作不可恢复。")) return;
      try {
        await fetch("/api/writing/chapters/" + id, { method: "DELETE" });
        const { chapters } = await fetch("/api/writing/chapters").then(
          (r) => r.json() as Promise<{ chapters: ChapterMeta[] }>
        );
        set({ chapters });
        if (get().currentChapterId === id) {
          if (chapters.length > 0) {
            await get().openChapter(chapters[0].id);
          } else {
            set({ currentChapterId: null, title: "", content: "" });
          }
        }
        toast.success("章节已删除");
      } catch {
        toast.error("删除失败");
      }
    },

    moveChapter: async (id, dir) => {
      const sorted = [...get().chapters].sort((a, b) => a.order - b.order);
      const i = sorted.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= sorted.length) return;
      const ids = sorted.map((c) => c.id);
      const tmp = ids[i];
      ids[i] = ids[j];
      ids[j] = tmp;
      try {
        const { chapters } = await fetch("/api/writing/chapters", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: ids }),
        }).then((r) => r.json() as Promise<{ chapters: ChapterMeta[] }>);
        set({ chapters });
      } catch {
        toast.error("调整顺序失败");
      }
    },

    setTitle: (title) => {
      set({ title, saveState: "dirty" });
      scheduleSave();
    },

    setContent: (content) => {
      set({ content, saveState: "dirty" });
      scheduleSave();
    },

    updateSelection: (selection) => set({ selection }),

    saveNow: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const { currentChapterId, title, content, saveState } = get();
      if (!currentChapterId || saveState === "saving") return;
      set({ saveState: "saving" });
      try {
        const { chapter } = await fetch("/api/writing/chapters/" + currentChapterId, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, content }),
        }).then((r) => r.json() as Promise<{ chapter: ChapterMeta }>);
        // 内容在此期间又被修改 → 保持 dirty,等下一轮保存
        if (get().content === content && get().title === title) {
          set({ saveState: "saved" });
        } else {
          set({ saveState: "dirty" });
          scheduleSave();
        }
        set((s) => ({
          chapters: s.chapters.map((c) => (c.id === chapter.id ? { ...c, ...chapter } : c)),
        }));
      } catch {
        set({ saveState: "error" });
      }
    },

    insertAtCursor: (text) => {
      const { content, selection } = get();
      const at = selection.start;
      const next = content.slice(0, at) + text + content.slice(at);
      set({ content: next, pendingCaret: at + [...text].length, saveState: "dirty" });
      scheduleSave();
    },

    replaceRange: (text, range) => {
      const { content } = get();
      const next = content.slice(0, range.start) + text + content.slice(range.end);
      set({ content: next, pendingCaret: range.start + [...text].length, saveState: "dirty" });
      scheduleSave();
    },

    appendChat: (msg) => set((s) => ({ chatMsgs: [...s.chatMsgs, msg] })),
    patchLastAssistant: (patch) =>
      set((s) => {
        const msgs = [...s.chatMsgs];
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          if (msgs[i].role === "assistant") {
            msgs[i] = { ...msgs[i], ...patch };
            break;
          }
        }
        return { chatMsgs: msgs };
      }),
    setChatStreaming: (chatStreaming) => set({ chatStreaming }),
    clearChat: () => set({ chatMsgs: [] }),
    resetAction: () => set({ action: EMPTY_ACTION }),
    patchAction: (patch) => set((s) => ({ action: { ...s.action, ...patch } })),
  };
});
