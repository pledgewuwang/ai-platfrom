"use client";

/**
 * 写作台主工作区(复刻自 ai-novel-writer WorkSpace,适配 shadcn/ui 设计令牌)
 * 三栏:章节侧栏 | 正文编辑区 | AI 助手;移动端底部标签切换。
 * 整个组件经 next/dynamic(ssr:false) 懒加载 —— 对话模式不加载写作台任何代码。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, Feather, MessagesSquare, PenLine } from "lucide-react";
import { useWritingStore } from "@/lib/writing/useWritingStore";
import ChapterSidebar from "./ChapterSidebar";
import EditorToolbar from "./EditorToolbar";
import ChapterEditor from "./ChapterEditor";
import AssistantPanel from "./AssistantPanel";

type Pane = "chapters" | "editor" | "assistant";

const MOBILE_TABS: { key: Pane; label: string; icon: typeof BookOpen }[] = [
  { key: "chapters", label: "章节", icon: BookOpen },
  { key: "editor", label: "正文", icon: PenLine },
  { key: "assistant", label: "AI", icon: MessagesSquare },
];

export default function WorkSpace() {
  const init = useWritingStore((s) => s.init);
  const [pane, setPane] = useState<Pane>("editor");

  useEffect(() => {
    void init();
  }, [init]);

  // 有未保存内容时阻止关闭页面
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useWritingStore.getState().saveState !== "saved") {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background text-foreground md:flex-row">
      {/* 移动端顶栏(桌面端品牌区在左侧栏) */}
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-card px-3 md:hidden">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Feather size={13} />
        </span>
        <p className="text-[13px] font-semibold">墨匠 · 写作台</p>
        <Link
          href="/"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
          title="返回对话平台"
        >
          返回平台
        </Link>
      </header>

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* 章节/记忆侧栏:移动端按标签显示,桌面端常驻 */}
        <div
          className={(pane === "chapters" ? "flex" : "hidden") + " w-full min-h-0 md:flex md:w-auto"}
        >
          <ChapterSidebar onOpenChapter={() => setPane("editor")} />
        </div>

        {/* 正文编辑区 */}
        <main
          className={
            (pane === "editor" ? "flex" : "hidden") +
            " w-full min-h-0 min-w-0 flex-col border-border bg-card md:flex md:w-auto md:flex-1 md:border-x"
          }
        >
          <EditorToolbar />
          <ChapterEditor onQuickAction={() => setPane("assistant")} />
        </main>

        {/* AI 助手栏:移动端按标签显示,桌面端常驻 */}
        <div
          className={(pane === "assistant" ? "flex" : "hidden") + " w-full min-h-0 md:flex md:w-auto"}
        >
          <AssistantPanel />
        </div>
      </div>

      {/* 移动端底部标签栏 */}
      <nav className="flex shrink-0 items-stretch gap-1 border-t border-border bg-card px-2 md:hidden">
        {MOBILE_TABS.map(({ key, label, icon: Icon }) => {
          const active = pane === key;
          return (
            <button
              key={key}
              onClick={() => setPane(key)}
              aria-current={active ? "page" : undefined}
              className={
                "flex flex-1 flex-col items-center gap-0.5 py-3 text-[11.5px] transition-colors " +
                (active ? "text-primary" : "text-muted-foreground")
              }
            >
              <Icon size={18} />
              {label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
