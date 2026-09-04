"use client";

/** AI 助手栏:对话/写作两页 + 模型状态 + 设置(复刻自 ai-novel-writer,适配平台共享配置) */
import { useEffect, useState } from "react";
import { MessagesSquare, PenLine, Settings } from "lucide-react";
import { useChatStore, chatApiKeyFor, resolveRoutedModel } from "@/store/chat-store";
import { useWritingStore } from "@/lib/writing/useWritingStore";
import ChatView from "./ChatView";
import ActionsView from "./ActionsView";
import WritingSettings from "./WritingSettings";
import type { WritingAction } from "@/lib/writing/types";

export default function AssistantPanel() {
  const [tab, setTab] = useState<"chat" | "actions">("chat");
  const [showSettings, setShowSettings] = useState(false);
  const [pendingAction, setPendingAction] = useState<WritingAction | null>(null);
  const settings = useChatStore((s) => s.settings);
  const action = useWritingStore((s) => s.action);

  const apiKey = chatApiKeyFor(settings);
  const model = resolveRoutedModel(settings);
  const aiOff = !apiKey && !model.startsWith("ollama/");

  // 编辑器浮动条触发的快捷动作:切到写作页并自动执行
  useEffect(() => {
    const handler = (e: Event) => {
      const a = (e as CustomEvent<{ action: WritingAction }>).detail?.action;
      if (a) {
        setTab("actions");
        setPendingAction(a);
      }
    };
    window.addEventListener("writing-quick-action", handler);
    return () => window.removeEventListener("writing-quick-action", handler);
  }, []);

  // 动作面板空闲后清掉待执行动作,避免切换标签页回来重复触发。
  // 渲染期同步 prev 状态(与平台 page.tsx 的会话切换同步同一模式),
  // 避免 effect 内 setState 引发的级联渲染。
  const [prevRunning, setPrevRunning] = useState(action.running);
  if (prevRunning !== action.running) {
    setPrevRunning(action.running);
    if (!action.running) setPendingAction(null);
  }

  return (
    <aside className="flex h-full w-full flex-col bg-card md:w-[380px] md:min-w-[340px]">
      <div className="flex gap-1 border-b border-border px-3 py-2">
        {(
          [
            { key: "chat", label: "对话", icon: MessagesSquare },
            { key: "actions", label: "写作", icon: PenLine },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] transition-colors " +
              (tab === key
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground")
            }
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
        <button
          onClick={() => setShowSettings(true)}
          title="模型设置(与对话平台共用)"
          className="flex shrink-0 items-center justify-center rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <Settings size={14} />
        </button>
      </div>

      {aiOff && (
        <button
          onClick={() => setShowSettings(true)}
          className="flex w-full items-start gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-left text-[12px] leading-relaxed text-amber-600 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
        >
          <Settings size={14} className="mt-0.5 shrink-0" />
          <span>尚未配置模型:点击打开「模型设置」,选择提供商并填入 API Key(与对话平台共用配置)。</span>
        </button>
      )}

      {/* 当前模型状态条 */}
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/20 px-3 py-1.5 text-[10.5px] text-muted-foreground">
        <span
          className={
            "size-1.5 shrink-0 rounded-full " + (aiOff ? "bg-amber-500/80" : "bg-emerald-500/80")
          }
        />
        <span className="truncate">{model}</span>
        {aiOff && <span className="shrink-0 text-amber-500/80">未配置 Key</span>}
      </div>

      {tab === "chat" ? (
        <ChatView />
      ) : (
        <ActionsView autoAction={pendingAction} />
      )}

      {showSettings && <WritingSettings onClose={() => setShowSettings(false)} />}
    </aside>
  );
}
