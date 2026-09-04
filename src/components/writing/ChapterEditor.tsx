"use client";

/** 正文编辑器:选区跟踪 + 浮动快捷动作条(复刻自 ai-novel-writer) */
import { useEffect, useRef, useState } from "react";
import { Feather, Sparkles, Eraser } from "lucide-react";
import { useWritingStore } from "@/lib/writing/useWritingStore";
import { tail, head } from "@/lib/writing/text";
import type { WritingAction } from "@/lib/writing/types";

export default function ChapterEditor({ onQuickAction }: { onQuickAction: () => void }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const content = useWritingStore((s) => s.content);
  const setContent = useWritingStore((s) => s.setContent);
  const saveNow = useWritingStore((s) => s.saveNow);
  const updateSelection = useWritingStore((s) => s.updateSelection);
  const newChapter = useWritingStore((s) => s.newChapter);
  const currentChapterId = useWritingStore((s) => s.currentChapterId);
  const pendingCaret = useWritingStore((s) => s.pendingCaret);
  const selection = useWritingStore((s) => s.selection);

  const [floating, setFloating] = useState(false);
  const [floatPos, setFloatPos] = useState({ top: 0, left: 0 });

  const hasSelection = selection.selectedText.trim().length > 0;

  useEffect(() => {
    const el = ref.current;
    if (el && pendingCaret !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret, pendingCaret);
      useWritingStore.setState({ pendingCaret: null, selection: buildSelection(el) });
    }
  }, [pendingCaret, content]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 防抖:selectionchange 在拖选时高频触发,长文 split 计算行列 O(n) 会卡
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const selText = el.value.slice(el.selectionStart, el.selectionEnd).trim();
        if (selText.length > 0) {
          const rect = el.getBoundingClientRect();
          const lineNum = el.value.slice(0, el.selectionEnd).split("\n").length;
          const lastLineLen = el.value.slice(0, el.selectionEnd).split("\n").pop()?.length ?? 0;
          const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 28;
          const top = Math.min(rect.top + lineNum * lineHeight + 4, rect.bottom - 44);
          const left = Math.min(rect.left + lastLineLen * 7.5 + 8, rect.right - 120);
          setFloatPos({ top: Math.max(rect.top + 8, top), left: Math.max(rect.left + 8, left) });
          setFloating(true);
        } else {
          setFloating(false);
        }
      }, 50);
    };
    document.addEventListener("selectionchange", handler);
    el.addEventListener("select", handler);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("selectionchange", handler);
      el.removeEventListener("select", handler);
    };
  }, [currentChapterId]);

  function buildSelection(el: HTMLTextAreaElement) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    return {
      start,
      end,
      selectedText: el.value.slice(start, end),
      beforeTail: tail(el.value.slice(0, start), 3000),
      afterHead: head(el.value.slice(end), 500),
    };
  }

  function syncSelection() {
    const el = ref.current;
    if (!el) return;
    updateSelection(buildSelection(el));
  }

  function runQuickAction(action: WritingAction) {
    syncSelection();
    onQuickAction();
    window.dispatchEvent(
      new CustomEvent("writing-quick-action", { detail: { action } })
    );
    setFloating(false);
  }

  if (!currentChapterId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
        <Feather size={32} className="text-muted-foreground/50" />
        <p className="text-sm">还没有章节,落笔从第一章开始</p>
        <button
          onClick={() => void newChapter()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          创建第一章
        </button>
      </div>
    );
  }

  return (
    <>
      <textarea
        ref={ref}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onSelect={syncSelection}
        onKeyUp={syncSelection}
        onClick={syncSelection}
        onBlur={() => void saveNow()}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void saveNow();
          }
        }}
        spellCheck={false}
        placeholder={
          "夜色像墨一样漫过窗棂,故事从这里开始…\n\n选中一段文字,即可在浮动条使用「润色 / 去 AI 化」;把光标放在段落末尾,试试右侧「续写」。"
        }
        className="min-h-0 flex-1 resize-none bg-transparent px-8 py-6 text-[15px] leading-loose outline-none placeholder:text-muted-foreground/50 md:px-14"
      />
      {floating && hasSelection && (
        <div
          className="fixed z-50 flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1.5 shadow-xl"
          style={{ top: floatPos.top, left: floatPos.left }}
        >
          <button
            onClick={() => runQuickAction("polish")}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-foreground/80 transition-colors hover:bg-primary/10 hover:text-primary"
            title="润色"
          >
            <Sparkles size={12} /> 润色
          </button>
          <button
            onClick={() => runQuickAction("deai")}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-foreground/80 transition-colors hover:bg-primary/10 hover:text-primary"
            title="去 AI 化"
          >
            <Eraser size={12} /> 去 AI 化
          </button>
          <div className="h-4 w-px bg-border" />
          <span className="max-w-[80px] truncate text-[10px] text-muted-foreground">
            {[...selection.selectedText.trim()].length} 字
          </span>
        </div>
      )}
    </>
  );
}
