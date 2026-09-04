"use client";

/** 写作台 AI 对话视图(复刻自 ai-novel-writer ChatView,精简:去掉文风范例学习/剧情沉淀) */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Send, Square, BookOpen, Feather, Trash2, CornerDownLeft } from "lucide-react";
import { toast } from "sonner";
import { useChatStore, chatApiKeyFor, resolveRoutedModel } from "@/store/chat-store";
import { makeMsg, useWritingStore } from "@/lib/writing/useWritingStore";
import { streamSse } from "@/lib/writing/sse-client";
import { tail, stripMarkdownLight } from "@/lib/writing/text";
import type { SseEvent } from "@/lib/writing/types";

export default function ChatView() {
  const chatMsgs = useWritingStore((s) => s.chatMsgs);
  const chatStreaming = useWritingStore((s) => s.chatStreaming);
  const clearChat = useWritingStore((s) => s.clearChat);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 是否贴底(贴底才跟随流式输出滚动,用户上翻时不打扰) */
  const stickRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [chatMsgs]);

  async function send() {
    const text = input.trim();
    if (!text || chatStreaming) return;
    setInput("");
    stickRef.current = true; // 自己发消息 → 强制回到底部跟随新回复

    const st = useWritingStore.getState();
    st.appendChat(makeMsg("user", text));
    st.appendChat(makeMsg("assistant", ""));
    st.setChatStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const history = useWritingStore
      .getState()
      .chatMsgs.filter((m) => m.content.trim().length > 0 && !m.failed)
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    const chapterContext = st.currentChapterId
      ? {
          title: st.title,
          cursorBefore: tail(st.selection.beforeTail || st.content, 1000),
        }
      : undefined;

    // 与对话平台相同的 API 规则:同一套设置 + 智能路由
    const s = useChatStore.getState().settings;

    let acc = "";
    try {
      await streamSse(
        "/api/writing/chat",
        {
          messages: history,
          chapterContext,
          chatApiUrl: s.chatApiUrl,
          chatApiKey: chatApiKeyFor(s),
          chatModel: resolveRoutedModel(s),
        },
        (ev: SseEvent) => {
          if (ev.type === "delta") {
            acc += ev.content;
            st.patchLastAssistant({ content: acc });
          } else if (ev.type === "memory") {
            if (ev.text) st.patchLastAssistant({ usedMemory: true });
          } else if (ev.type === "error") {
            st.patchLastAssistant({ failed: true, content: acc || ev.message });
            if (acc) toast.error(ev.message);
          }
        },
        ctrl.signal
      );
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        st.patchLastAssistant({ failed: true });
        toast.error("请求失败,请检查网络后重试");
      }
      // 主动停止:保留已生成的部分内容
    } finally {
      st.setChatStreaming(false);
      abortRef.current = null;
      // 清理没有任何内容的空占位
      const msgs = useWritingStore.getState().chatMsgs;
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant" && !last.content.trim()) {
        useWritingStore.setState((s) => ({ chatMsgs: s.chatMsgs.slice(0, -1) }));
      }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {chatMsgs.length === 0 && <EmptyHint />}
        {chatMsgs.length > 0 && (
          <div className="flex justify-end gap-3">
            <button
              onClick={clearChat}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-destructive"
            >
              <Trash2 size={11} /> 清空对话
            </button>
          </div>
        )}
        {chatMsgs.map((m, i) => (
          <Message
            key={m.id}
            msg={m}
            streaming={chatStreaming && i === chatMsgs.length - 1 && m.role === "assistant"}
          />
        ))}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="与 AI 讨论剧情、人物、设定…(Enter 发送,Shift+Enter 换行)"
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-input bg-muted/30 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {chatStreaming ? (
            <button
              onClick={stop}
              title="停止生成"
              className="flex size-[44px] shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:border-destructive/60 hover:text-destructive"
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              title="发送"
              className="flex size-[44px] shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Send size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <BookOpen size={20} />
      </div>
      <p className="text-sm text-muted-foreground">
        与 AI 聊聊你的故事:人物动机、情节走向、世界观漏洞…
      </p>
      <p className="px-6 text-xs leading-relaxed text-muted-foreground/70">
        回答会自动结合分级记忆(历史讨论与写作上下文)与光标前文,
        保证续写和讨论与你的故事一致。
      </p>
    </div>
  );
}

function Message({
  msg,
  streaming,
}: {
  msg: ReturnType<typeof makeMsg>;
  streaming?: boolean;
}) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-muted px-3.5 py-2.5 text-sm leading-relaxed">
          {msg.content}
        </div>
      </div>
    );
  }

  /** 一键插入正文:清理 Markdown 标记后插入编辑器光标处 */
  function insertToEditor() {
    const text = stripMarkdownLight(msg.content).trim();
    if (!text) return;
    const st = useWritingStore.getState();
    const prev = st.content.slice(0, st.selection.start);
    // 与光标前文衔接:两者之间保一个换行,避免粘在上一段末尾
    const insertText =
      prev.length > 0 && !prev.endsWith("\n") && !text.startsWith("\n") ? "\n" + text : text;
    st.insertAtCursor(insertText);
    toast.success("已插入到光标处");
  }

  return (
    <div className={"group space-y-1.5 " + (msg.failed ? "text-destructive/90" : "")}>
      <div className="flex items-start gap-2">
        <div className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Feather size={12} />
        </div>
        <div className="min-w-0 flex-1">
          {msg.content ? (
            <div className="text-sm leading-relaxed">
              <ReactMarkdown
                components={{
                  p: (props) => <p className="mb-2 last:mb-0" {...props} />,
                  ul: (props) => <ul className="mb-2 list-disc space-y-1 pl-5" {...props} />,
                  ol: (props) => <ol className="mb-2 list-decimal space-y-1 pl-5" {...props} />,
                  h1: (props) => <h1 className="mb-1.5 text-base font-semibold" {...props} />,
                  h2: (props) => <h2 className="mb-1.5 text-base font-semibold" {...props} />,
                  h3: (props) => <h3 className="mb-1.5 font-semibold" {...props} />,
                  blockquote: (props) => (
                    <blockquote
                      className="mb-2 border-l-2 border-border pl-3 text-muted-foreground"
                      {...props}
                    />
                  ),
                }}
              >
                {msg.content}
              </ReactMarkdown>
            </div>
          ) : null}
        </div>
      </div>
      {/* 一键插入正文:桌面 hover 浮现,移动端常显(触屏无 hover) */}
      {!streaming && !msg.failed && msg.content.trim() && (
        <div className="flex pl-7">
          <button
            onClick={insertToEditor}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-primary/10 hover:text-primary focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"
            title="清理 Markdown 标记后插入编辑器光标处"
          >
            <CornerDownLeft size={11} /> 插入正文
          </button>
        </div>
      )}
      {streaming && <ThinkingDots />}
      {msg.usedMemory && !streaming && (
        <div className="flex pl-7">
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
            <BookOpen size={10} /> 已参考分级记忆
          </span>
        </div>
      )}
    </div>
  );
}

/** 思考中… 三点依次出现的动画 */
function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5 pl-7 text-[11px] text-muted-foreground">
      <span>思考中</span>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-[4px] rounded-full bg-primary"
            style={{
              animation: "writing-thinking-bounce 1.2s ease-in-out infinite",
              animationDelay: i * 0.18 + "s",
            }}
          />
        ))}
      </span>
      <style>{`
        @keyframes writing-thinking-bounce {
          0%, 60%, 100% { opacity: 0.15; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-2px); }
        }
      `}</style>
    </div>
  );
}
