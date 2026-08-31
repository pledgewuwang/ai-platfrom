"use client";

import React, { memo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/store/chat-store";
import { Bot, User, Copy, Check, Pencil, RefreshCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

interface MessageBubbleProps {
  message: ChatMessage;
  isLast?: boolean;
  onRegenerate?: () => void;
  /** 编辑用户消息并从该处重新生成 */
  onEditMessage?: (messageId: string, content: string) => void;
}

/* ── 代码块:带复制按钮 ─────────────────────────────────── */

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = preRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用(非 https 环境)时静默
    }
  };

  return (
    <div className="relative group/code my-2">
      <pre
        ref={preRef}
        className="bg-muted/60 rounded-lg p-3 overflow-x-auto text-xs leading-relaxed"
      >
        {children}
      </pre>
      <button
        onClick={handleCopy}
        title="复制代码"
        className="absolute top-2 right-2 p-1.5 rounded-md bg-background/80 border border-border text-muted-foreground hover:text-foreground opacity-0 group-hover/code:opacity-100 transition-opacity"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}

/* ── Markdown 渲染配置 ───────────────────────────────────
 * react-markdown 默认不解析内嵌 HTML(未配置 rehype-raw),
 * URL 也经过默认转换清洗 —— 不需要手写转义即可防 XSS。
 */

const markdownComponents = {
  pre: ({ children }: { children?: React.ReactNode }) => (
    <CodeBlock>{children}</CodeBlock>
  ),
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) =>
    className?.includes("language-") ? (
      <code className={cn("font-mono text-xs", className)}>{children}</code>
    ) : (
      <code className="bg-muted/60 px-1.5 py-0.5 rounded text-xs font-mono">
        {children}
      </code>
    ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-400 hover:underline break-all"
    >
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full text-xs border-collapse border border-border">
        {children}
      </table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-border bg-muted/50 px-2 py-1 text-left font-medium whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border border-border px-2 py-1 align-top">{children}</td>
  ),
};

/* ── 工具调用状态条 ────────────────────────────────────── */

function ToolStatus({ message }: { message: ChatMessage }) {
  const events = message.toolEvents ?? [];
  if (events.length === 0) return null;

  const running = events.some((e) => e.status === "running");

  if (running) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-1 px-1">
        <span className="size-1.5 rounded-full bg-blue-400 animate-pulse" />
        正在{events[events.length - 1].label}…
      </div>
    );
  }

  return (
    <details className="text-[11px] text-muted-foreground mb-1">
      <summary className="cursor-pointer select-none hover:text-foreground px-1">
        🔧 {events.length} 次工具调用
      </summary>
      <ul className="mt-1 space-y-0.5 pl-5 list-disc">
        {events.map((ev, i) => (
          <li key={i}>
            {ev.label}
            {ev.detail ? <span className="ml-1 opacity-70">— {ev.detail}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/* ── 消息气泡 ──────────────────────────────────────────── */

export const MessageBubble = memo(function MessageBubble({
  message,
  isLast,
  onRegenerate,
  onEditMessage,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleSaveEdit = () => {
    const content = draft.trim();
    if (content && content !== message.content) {
      onEditMessage?.(message.id, content);
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "flex gap-3 py-4 group",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground"
        )}
      >
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </div>

      {/* Content */}
      <div
        className={cn(
          "flex flex-col gap-1 max-w-[80%] min-w-0",
          isUser ? "items-end" : "items-start"
        )}
      >
        {/* 工具调用状态(仅助手消息) */}
        {!isUser && <ToolStatus message={message} />}

        {/* Text content */}
        {editing ? (
          <div className="w-full min-w-[280px] flex flex-col gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-input bg-muted/30 px-3 py-2 text-sm resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setEditing(false);
                  setDraft(message.content);
                }}
                className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                className="text-xs px-2 py-1 rounded-md bg-primary text-primary-foreground"
              >
                保存并重新发送
              </button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              "rounded-xl px-4 py-2.5 text-sm leading-relaxed max-w-none break-words",
              isUser
                ? "bg-primary text-primary-foreground rounded-tr-sm"
                : "bg-muted text-foreground rounded-tl-sm"
            )}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={markdownComponents}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Images */}
        {message.imageUrls && message.imageUrls.length > 0 && !editing && (
          <div className="flex flex-wrap gap-2 mt-1">
            {message.imageUrls.map((url, idx) => (
              <div key={idx} className="relative group/img">
                <img
                  src={url}
                  alt={`Generated image ${idx + 1}`}
                  className="max-w-[300px] max-h-[300px] rounded-lg object-cover cursor-pointer hover:opacity-90 transition-opacity"
                  loading="lazy"
                />
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded opacity-0 group-hover/img:opacity-100 transition-opacity"
                >
                  打开原图
                </a>
              </div>
            ))}
          </div>
        )}

        {/* Hover 操作栏:复制 / 编辑(用户) / 重新生成(最后一条助手) */}
        {!editing && (
          <div
            className={cn(
              "flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity px-1",
              isUser ? "flex-row-reverse" : "flex-row"
            )}
          >
            <button
              onClick={handleCopy}
              title="复制"
              className="p-1 rounded text-muted-foreground/60 hover:text-foreground"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
            {isUser && onEditMessage && (
              <button
                onClick={() => {
                  setDraft(message.content);
                  setEditing(true);
                }}
                title="编辑并重新发送"
                className="p-1 rounded text-muted-foreground/60 hover:text-foreground"
              >
                <Pencil className="size-3" />
              </button>
            )}
            {!isUser && isLast && onRegenerate && (
              <button
                onClick={onRegenerate}
                title="重新生成"
                className="p-1 rounded text-muted-foreground/60 hover:text-foreground"
              >
                <RefreshCw className="size-3" />
              </button>
            )}
            <span className="text-[10px] text-muted-foreground ml-1">
              {new Date(message.timestamp).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
