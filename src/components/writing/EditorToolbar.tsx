"use client";

/** 编辑器工具栏:标题 + 字数 + 保存状态 + 导出(复刻自 ai-novel-writer) */
import { Save, Loader2, Download } from "lucide-react";
import { toast } from "sonner";
import { useWritingStore } from "@/lib/writing/useWritingStore";
import { countWords } from "@/lib/writing/text";
import type { Chapter } from "@/lib/writing/types";

const SAVE_BADGE: Record<string, { label: string; cls: string }> = {
  saved: { label: "已保存", cls: "text-emerald-500/90" },
  dirty: { label: "未保存", cls: "text-amber-500/90" },
  saving: { label: "保存中…", cls: "text-muted-foreground" },
  error: { label: "保存失败", cls: "text-destructive" },
};

export default function EditorToolbar() {
  const title = useWritingStore((s) => s.title);
  const setTitle = useWritingStore((s) => s.setTitle);
  const content = useWritingStore((s) => s.content);
  const saveState = useWritingStore((s) => s.saveState);
  const saveNow = useWritingStore((s) => s.saveNow);
  const currentChapterId = useWritingStore((s) => s.currentChapterId);

  const badge = SAVE_BADGE[saveState];

  /** 导出全本 Markdown(前端拼装 + Blob 下载) */
  async function exportNovel() {
    try {
      const res = await fetch("/api/writing/chapters?full=1");
      const { chapters } = (await res.json()) as { chapters: Chapter[] };
      if (chapters.length === 0) {
        toast.error("还没有可导出的章节");
        return;
      }
      const parts = chapters.map((ch) => "# " + ch.title + "\n\n" + ch.content.trim());
      const md = "# 我的小说\n\n" + parts.join("\n\n---\n\n") + "\n";
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "我的小说.md";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("已导出 " + chapters.length + " 章");
    } catch {
      toast.error("导出失败");
    }
  }

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2.5 md:gap-3 md:px-5 md:py-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="章节标题…"
        disabled={!currentChapterId}
        className="min-w-0 flex-1 bg-transparent text-base font-medium outline-none placeholder:text-muted-foreground/60 md:text-lg"
      />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {countWords(content)} 字
      </span>
      <span className={"shrink-0 text-xs " + badge.cls} title={badge.label}>
        <span className="md:hidden">
          {saveState === "saving" ? "…" : "●"}
        </span>
        <span className="hidden md:inline">{badge.label}</span>
      </span>
      <button
        onClick={() => void exportNovel()}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary md:px-2.5 md:py-1"
        title="导出全本 Markdown"
      >
        <Download size={12} />
        <span className="hidden md:inline">导出</span>
      </button>
      <button
        onClick={() => void saveNow()}
        disabled={!currentChapterId || saveState === "saving"}
        className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40 md:px-2.5 md:py-1"
        title="Ctrl+S"
      >
        {saveState === "saving" ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <Save size={12} />
        )}
        <span className="hidden md:inline">保存</span>
      </button>
    </div>
  );
}
