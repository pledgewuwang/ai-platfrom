"use client";

/** 章节侧栏:品牌区 + 章节列表 + 新建(复刻自 ai-novel-writer Sidebar/ChapterList) */
import Link from "next/link";
import { Plus, Trash2, ChevronUp, ChevronDown, Feather, ArrowLeft } from "lucide-react";
import { useWritingStore } from "@/lib/writing/useWritingStore";

export default function ChapterSidebar({ onOpenChapter }: { onOpenChapter: () => void }) {
  const chapters = useWritingStore((s) => s.chapters);
  const currentChapterId = useWritingStore((s) => s.currentChapterId);
  const openChapter = useWritingStore((s) => s.openChapter);
  const newChapter = useWritingStore((s) => s.newChapter);
  const deleteChapter = useWritingStore((s) => s.deleteChapter);
  const moveChapter = useWritingStore((s) => s.moveChapter);

  const sorted = [...chapters].sort((a, b) => a.order - b.order);

  return (
    <aside className="flex h-full w-full flex-col bg-card md:w-[280px] md:min-w-[280px]">
      {/* 品牌区(仅桌面端显示) */}
      <div className="hidden items-center gap-2.5 border-b border-border px-4 py-3.5 md:flex">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Feather size={17} />
        </span>
        <div className="leading-tight">
          <p className="text-[15px] font-semibold">墨匠 · 写作台</p>
          <p className="text-[11px] text-muted-foreground">AI 小说写作</p>
        </div>
      </div>

      {/* 平台互跳:写作台与对话平台共享同一根布局/鉴权 */}
      <Link
        href="/"
        className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        title="返回对话平台(写作台与对话共用模型配置)"
      >
        <ArrowLeft size={13} />
        返回对话平台
      </Link>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex flex-col gap-1">
          {sorted.map((ch, i) => {
            const active = ch.id === currentChapterId;
            return (
              <div
                key={ch.id}
                className={
                  "group relative flex items-center rounded-lg border transition-colors " +
                  (active
                    ? "border-primary/40 bg-primary/5"
                    : "border-transparent hover:border-border hover:bg-muted/40")
                }
              >
                <button
                  onClick={() => {
                    void openChapter(ch.id);
                    onOpenChapter();
                  }}
                  className="flex min-w-0 flex-1 items-baseline gap-2 px-3 py-2.5 text-left"
                >
                  <span
                    className={
                      "text-xs tabular-nums " + (active ? "text-primary" : "text-muted-foreground")
                    }
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {ch.title || "未命名章节"}
                  </span>
                </button>

                {/* 桌面 hover 浮现;移动端常显(触屏没有 hover) */}
                <div className="absolute right-2 hidden items-center gap-0.5 rounded-md bg-muted px-1 py-0.5 shadow group-hover:flex max-md:flex">
                  <button
                    title="上移"
                    disabled={i === 0}
                    onClick={() => void moveChapter(ch.id, -1)}
                    className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    title="下移"
                    disabled={i === sorted.length - 1}
                    onClick={() => void moveChapter(ch.id, 1)}
                    className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    title="删除"
                    onClick={() => void deleteChapter(ch.id)}
                    className="rounded p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>

                <span className="pr-3 text-[10px] text-muted-foreground group-hover:invisible max-md:hidden">
                  {ch.wordCount > 0 ? ch.wordCount + " 字" : "空"}
                </span>
              </div>
            );
          })}

          <button
            onClick={() => void newChapter()}
            className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-[13px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
          >
            <Plus size={14} />
            新建章节
          </button>
        </div>
      </div>
    </aside>
  );
}
