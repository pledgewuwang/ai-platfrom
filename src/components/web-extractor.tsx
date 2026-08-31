"use client";

import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Globe, Loader2, Copy, Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";

interface ExtractResult {
  url: string;
  title: string;
  content: string;
  metadata: {
    description?: string;
    author?: string;
    publishDate?: string;
  };
  stats: {
    originalSize: number;
    extractedSize: number;
    compressionRatio: number;
  };
}

interface WebExtractorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsertToChat?: (text: string) => void;
}

export function WebExtractor({
  open,
  onOpenChange,
  onInsertToChat,
}: WebExtractorProps) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);
  const [copied, setCopied] = useState(false);

  const handleExtract = async () => {
    if (!url.trim()) {
      toast.error("请输入 URL");
      return;
    }

    // Auto-add https:// if missing
    let targetUrl = url.trim();
    if (!targetUrl.startsWith("http")) {
      targetUrl = "https://" + targetUrl;
    }

    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls: targetUrl,
          options: { maxContentLength: 10000, extractLinks: true },
          format: "raw",
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "提取失败");
      }

      setResult(data.data[0]);
      toast.success(`提取成功，压缩率 ${data.data[0].stats.compressionRatio}%`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "提取失败";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleInsert = () => {
    if (!result || !onInsertToChat) return;
    onInsertToChat(result.content);
    toast.success("已插入到对话");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="size-5" />
            网页提取
          </DialogTitle>
          <DialogDescription>
            输入 URL，智能提取网页关键信息（自动压缩，避免 token 爆炸）
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-hidden flex flex-col gap-4 min-h-0">
          {/* URL Input */}
          <div className="flex gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/article"
              onKeyDown={(e) => e.key === "Enter" && handleExtract()}
              className="flex-1"
            />
            <Button
              onClick={handleExtract}
              disabled={loading || !url.trim()}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "提取"
              )}
            </Button>
          </div>

          {/* Result */}
          {result && (
            <div className="flex-1 overflow-hidden flex flex-col gap-3 min-h-0">
              {/* Stats Bar */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{result.title}</span>
                <span>·</span>
                <span>
                  {result.stats.originalSize.toLocaleString()} →{" "}
                  {result.stats.extractedSize.toLocaleString()} 字符
                </span>
                <span className="text-green-500 font-medium">
                  压缩 {result.stats.compressionRatio}%
                </span>
                {result.metadata.author && (
                  <>
                    <span>·</span>
                    <span>{result.metadata.author}</span>
                  </>
                )}
              </div>

              {/* Metadata */}
              {result.metadata.description && (
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {result.metadata.description}
                </p>
              )}

              {/* Content */}
              <ScrollArea className="flex-1 rounded-lg border bg-muted/20 p-3">
                <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed">
                  {result.content}
                </pre>
              </ScrollArea>
            </div>
          )}
        </div>

        <DialogFooter className="flex-row justify-between">
          <div className="flex gap-2">
            {result && (
              <>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? (
                    <Check className="size-3 mr-1" />
                  ) : (
                    <Copy className="size-3 mr-1" />
                  )}
                  {copied ? "已复制" : "复制"}
                </Button>
                {onInsertToChat && (
                  <Button size="sm" onClick={handleInsert}>
                    插入到对话
                  </Button>
                )}
              </>
            )}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
