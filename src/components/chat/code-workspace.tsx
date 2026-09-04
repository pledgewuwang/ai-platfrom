"use client";

import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, Check, Copy, FileCode, Sparkles } from "lucide-react";
import type { ChatMessage } from "@/store/chat-store";
import { toast } from "sonner";

interface WorkspaceFile {
  id: string;
  name: string;
  lang: string;
  content: string;
  approved: boolean;
}

/** 从助手回复中解析 ```lang\ncode``` 代码块为工作区文件 */
function extractCodeFiles(messages: ChatMessage[]): WorkspaceFile[] {
  const files: WorkspaceFile[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const re = /```([a-zA-Z0-9+#.-]*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(m.content))) {
      const lang = (match[1] || "txt").trim() || "txt";
      const code = (match[2] ?? "").replace(/\r?\n$/, "");
      const ext = lang === "txt" ? "txt" : lang.split(".").pop() || "txt";
      files.push({
        id: `${m.id}-${files.length}`,
        name: `file_${files.length + 1}.${ext}`,
        lang,
        content: code,
        approved: false,
      });
    }
  }
  return files;
}

interface CodeWorkspaceProps {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  /** 流式生成中:跳过解析与重置(避免每 token 正则全文扫描 + 覆盖用户编辑) */
  isStreaming?: boolean;
}

/**
 * 人机协作编程的工作区:对话右侧面板。
 * 把 AI 回复中的代码块解析为文件列表,支持重命名 / 编辑 / 批准 / 复制。
 */
export function CodeWorkspace({ open, onClose, messages, isStreaming = false }: CodeWorkspaceProps) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 从对话代码块解析文件;仅在「代码块集合」变化时重置 files,
  // 用户手动编辑过的内容在 messages 未变时保留(渲染期同步,避免 effect 级联 setState)。
  // 流式期间直接跳过解析(parsedKey 为 null):省掉每 token 的全文正则扫描,
  // 也避免把正在编辑的内容每 token 重置;流结束后做一次最终重置。
  const parsed = useMemo(
    () => (open && !isStreaming ? extractCodeFiles(messages) : null),
    [open, isStreaming, messages]
  );
  const parsedKey = parsed ? parsed.map((f) => f.id + ":" + f.content.length).join("|") : null;
  const [prevKey, setPrevKey] = useState<string | null>(parsedKey);
  if (parsedKey !== null && parsedKey !== prevKey) {
    setPrevKey(parsedKey);
    setFiles(parsed ?? []);
    setSelectedId(parsed && parsed.length > 0 ? parsed[0].id : null);
  }

  const selected = files.find((f) => f.id === selectedId) ?? null;

  const updateContent = (id: string, content: string) => {
    setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, content } : f)));
  };
  const toggleApprove = (id: string) => {
    setFiles((fs) => fs.map((f) => (f.id === id ? { ...f, approved: !f.approved } : f)));
  };
  const copyFile = async (f: WorkspaceFile) => {
    try {
      await navigator.clipboard.writeText(f.content);
      toast.success(`已复制 ${f.name}`);
    } catch {
      toast.error("复制失败");
    }
  };

  if (!open) return null;

  return (
    <aside className="w-80 h-full border-l border-border bg-card flex flex-col flex-shrink-0 min-w-0">
      <div className="flex items-center justify-between px-3 h-11 border-b border-border flex-shrink-0">
        <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <FileCode className="size-3.5" />
          工作区 ({files.length})
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="关闭工作区">
          <X className="size-4" />
        </Button>
      </div>

      {files.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground px-4 text-center leading-relaxed">
          <Sparkles className="size-6 text-primary/40" />
          <div>人机协作模式下,AI 回复的代码块会自动解析为文件</div>
          <div>在此查看 / 编辑 / 批准后再采用</div>
          <div className="pt-1 text-[11px]">可以先在左边对话发起一个编程问题 🎯</div>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          {/* 文件列表 */}
          <div className="border-b border-border p-2 space-y-1 max-h-40 overflow-auto flex-shrink-0">
            {files.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setSelectedId(f.id)}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left text-xs ${
                  selectedId === f.id ? "bg-muted" : "hover:bg-muted/60"
                }`}
              >
                <span className="flex-1 truncate font-mono">{f.name}</span>
                {f.approved && <Check className="size-3.5 text-green-500" />}
              </button>
            ))}
          </div>

          {/* 选中文件编辑区 */}
          {selected && (
            <div className="flex-1 flex flex-col min-h-0 p-2 space-y-2">
              <input
                value={selected.name}
                onChange={(e) =>
                  setFiles((fs) => fs.map((f) => (f.id === selected.id ? { ...f, name: e.target.value } : f)))
                }
                className="flex-1 text-xs font-mono bg-muted/50 border border-input rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <textarea
                value={selected.content}
                onChange={(e) => updateContent(selected.id, e.target.value)}
                spellCheck={false}
                className="flex-1 min-h-0 w-full font-mono text-xs bg-background border border-input rounded p-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => copyFile(selected)}
                >
                  <Copy className="size-3.5" /> 复制
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="flex-1"
                  variant={selected.approved ? "secondary" : "default"}
                  onClick={() => toggleApprove(selected.id)}
                >
                  <Check className="size-3.5" /> {selected.approved ? "已批准" : "批准"}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
