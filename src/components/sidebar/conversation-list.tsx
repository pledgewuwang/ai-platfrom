"use client";

import React, { useRef } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useChatStore } from "@/store/chat-store";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  Plus,
  MessageSquare,
  Trash2,
  Images,
  Download,
  Upload,
} from "lucide-react";

interface ConversationListProps {
  onMobileClose?: () => void;
}

export function ConversationList({ onMobileClose }: ConversationListProps) {
  const {
    conversations,
    currentConversationId,
    createConversation,
    deleteConversation,
    setCurrentConversation,
  } = useChatStore();

  const importInputRef = useRef<HTMLInputElement>(null);

  const handleCreate = () => {
    createConversation();
    onMobileClose?.();
  };

  const handleSelect = (id: string) => {
    setCurrentConversation(id);
    onMobileClose?.();
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirm("确定删除这个对话吗?删除后无法恢复。")) {
      deleteConversation(id);
      toast.success("对话已删除");
    }
  };

  /** 导出全部对话为 JSON 备份 */
  const handleExport = async () => {
    try {
      const res = await fetch("/api/conversations/export");
      if (!res.ok) throw new Error(`导出失败 (${res.status})`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ai-platform-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success("备份已下载");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导出失败");
    }
  };

  /** 从备份 JSON 导入(按 id 去重,幂等) */
  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const list = Array.isArray(data) ? data : data.conversations;
      if (!Array.isArray(list)) throw new Error("文件格式不对,需要导出的备份 JSON");
      const res = await fetch("/api/conversations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversations: list }),
      });
      if (!res.ok) throw new Error(`导入失败 (${res.status})`);
      const result = await res.json();
      toast.success(`已导入 ${result.imported} 个对话,刷新后生效`);
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "导入失败");
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* New Conversation Button */}
      <div className="p-3">
        <Button
          onClick={handleCreate}
          className="w-full justify-start gap-2"
          variant="outline"
        >
          <Plus className="size-4" />
          新建对话
        </Button>
      </div>

      {/* Conversation List */}
      <ScrollArea className="flex-1">
        <div className="px-2 pb-4 space-y-1">
          {conversations.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <MessageSquare className="size-8 mx-auto mb-2 opacity-30" />
              <p>暂无对话</p>
              <p className="text-xs mt-1">点击上方按钮开始</p>
            </div>
          ) : (
            conversations.map((conversation) => (
              <div
                key={conversation.id}
                onClick={() => handleSelect(conversation.id)}
                className={cn(
                  "group flex items-center gap-2 rounded-lg px-3 py-2.5 cursor-pointer transition-colors",
                  "hover:bg-muted/50",
                  currentConversationId === conversation.id
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground"
                )}
              >
                <MessageSquare className="size-4 flex-shrink-0" />
                <span className="flex-1 truncate text-sm">
                  {conversation.title}
                </span>
                <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">
                  {new Date(conversation.updatedAt).toLocaleDateString("zh-CN", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
                <button
                  onClick={(e) => handleDelete(e, conversation.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 hover:text-destructive"
                  title="删除对话"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Footer info */}
      <div className="p-3 border-t border-border flex flex-col gap-2">
        <Link href="/gallery" onClick={() => onMobileClose?.()}>
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
            <Images className="size-4" />
            生成图片历史
          </Button>
        </Link>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-start gap-2 text-[11px] text-muted-foreground h-7"
            onClick={handleExport}
            title="导出全部对话为 JSON 备份"
          >
            <Download className="size-3.5" />
            导出
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-start gap-2 text-[11px] text-muted-foreground h-7"
            onClick={() => importInputRef.current?.click()}
            title="从备份 JSON 导入"
          >
            <Upload className="size-3.5" />
            导入
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              e.target.value = "";
            }}
          />
        </div>
        <p className="text-[10px] text-muted-foreground text-center">
          {conversations.length} 个对话
        </p>
      </div>
    </div>
  );
}
