"use client";

/** 写作动作视图:快捷动作 + 结果预览(复刻自 ai-novel-writer ActionsView/QuickActions/ActionPreview 合并精简) */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PenLine, Sparkles, Expand, Shrink, ListTree, Eraser, RotateCcw, X, CornerDownLeft, Replace, Square } from "lucide-react";
import { useChatStore, chatApiKeyFor, resolveRoutedModel } from "@/store/chat-store";
import { useWritingStore } from "@/lib/writing/useWritingStore";
import { streamSse } from "@/lib/writing/sse-client";
import type { SseEvent, WritingAction } from "@/lib/writing/types";

/** 上次执行的参数(用于「重试」) */
type LastRun = {
  action: WritingAction;
  selection: string;
  before: string;
  after: string;
  chapterTitle: string;
  instruction: string;
  range: { start: number; end: number };
};

const QUICK_ACTIONS: { type: WritingAction; label: string; icon: typeof PenLine; desc: string }[] = [
  { type: "continue", label: "续写", icon: PenLine, desc: "从光标处自然衔接续写约 400 字" },
  { type: "polish", label: "润色", icon: Sparkles, desc: "提升语言表现力,情节不变(需选中)" },
  { type: "expand", label: "扩写", icon: Expand, desc: "扩至约两倍,补细节与描写(需选中)" },
  { type: "shorten", label: "缩写", icon: Shrink, desc: "压至约三分之二,保留关键情节(需选中)" },
  { type: "deai", label: "去 AI 化", icon: Eraser, desc: "最小幅度修掉 AI 腔(需选中)" },
  { type: "outline", label: "大纲", icon: ListTree, desc: "从正文或选区提炼层级大纲" },
];

export default function ActionsView({ autoAction }: { autoAction: WritingAction | null }) {
  const [instruction, setInstruction] = useState("");
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const action = useWritingStore((s) => s.action);
  const resetAction = useWritingStore((s) => s.resetAction);

  // 编辑器浮动条触发的快捷动作:自动执行一次
  useEffect(() => {
    if (autoAction) void runAction(autoAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAction]);

  async function runAction(type: WritingAction, override?: LastRun) {
    const st = useWritingStore.getState();
    if (st.action.running) return;
    if (!st.currentChapterId) {
      toast.error("请先打开或新建一个章节");
      return;
    }
    const sel = override
      ? {
          selectedText: override.selection,
          beforeTail: override.before,
          afterHead: override.after,
          start: override.range.start,
          end: override.range.end,
        }
      : st.selection;
    const range = override?.range ?? { start: st.selection.start, end: st.selection.end };

    if (["polish", "expand", "shorten", "deai"].includes(type) && !sel.selectedText.trim()) {
      toast.error("请先在编辑器中选中要处理的文字");
      return;
    }
    if (type === "continue" && !st.content.trim()) {
      toast.error("先写一点正文,AI 才能衔接续写");
      return;
    }

    const params: LastRun = {
      action: type,
      selection: sel.selectedText,
      before: sel.beforeTail,
      after: sel.afterHead,
      chapterTitle: st.title,
      instruction,
      range,
    };
    setLastRun(params);

    st.patchAction({ running: true, type, text: "", failed: false, range });
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // 与对话平台相同的 API 规则:同一套设置 + 智能路由
    const s = useChatStore.getState().settings;

    try {
      await streamSse(
        "/api/writing/actions",
        {
          action: type,
          selection: params.selection,
          before: params.before,
          after: params.after,
          instruction: params.instruction || undefined,
          chapterTitle: params.chapterTitle,
          chatApiUrl: s.chatApiUrl,
          chatApiKey: chatApiKeyFor(s),
          chatModel: resolveRoutedModel(s),
        },
        (ev: SseEvent) => {
          if (ev.type === "delta") {
            const acc = useWritingStore.getState().action.text + ev.content;
            st.patchAction({ text: acc });
          } else if (ev.type === "error") {
            st.patchAction({ failed: true });
            toast.error(ev.message);
          }
        },
        ctrl.signal
      );
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // 主动停止:已生成的部分保留(写入 text),显式标记未失败
        st.patchAction({ failed: false });
      } else {
        st.patchAction({ failed: true });
        toast.error("请求失败,请重试");
      }
    } finally {
      st.patchAction({ running: false });
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const hasResult = action.type !== null && (action.running || action.text.length > 0 || action.failed);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          {QUICK_ACTIONS.map(({ type, label, icon: Icon, desc }) => (
            <button
              key={type}
              disabled={action.running}
              onClick={() => void runAction(type)}
              title={desc}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left text-[13px] transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40"
            >
              <Icon size={15} className="shrink-0" />
              {label}
            </button>
          ))}
        </div>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={2}
          placeholder="附加要求(可选):如「多用对话」「压缩到 200 字以内」…"
          className="w-full resize-none rounded-lg border border-input bg-muted/30 px-3 py-2 text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>

      {hasResult && (
        <div className="min-h-0 flex-1 border-t border-border p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              {action.running ? "生成中…" : action.failed ? "生成失败" : "生成结果"}
            </span>
            <div className="flex items-center gap-1">
              {action.running && (
                <button
                  onClick={stop}
                  title="停止生成"
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-destructive"
                >
                  <Square size={11} /> 停止
                </button>
              )}
              {!action.running && lastRun && (
                <button
                  onClick={() => void runAction(lastRun.action, lastRun)}
                  title="用相同参数重试"
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw size={11} /> 重试
                </button>
              )}
              <button
                onClick={resetAction}
                title="放弃本次结果"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-destructive"
              >
                <X size={11} /> 放弃
              </button>
            </div>
          </div>
          <div className="max-h-[45vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-3 text-sm leading-relaxed">
            {action.text || (action.running ? "…" : "(无输出)")}
          </div>
          {!action.running && action.text.trim() && !action.failed && (
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => {
                  useWritingStore.getState().insertAtCursor(action.text.trim());
                  toast.success("已插入到光标处");
                }}
                className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <CornerDownLeft size={12} /> 插入光标处
              </button>
              <button
                onClick={() => {
                  if (!action.range) {
                    toast.error("本次动作没有选区记录");
                    return;
                  }
                  useWritingStore.getState().replaceRange(action.text.trim(), action.range);
                  toast.success("已替换选中文字");
                }}
                className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
              >
                <Replace size={12} /> 替换选中
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
