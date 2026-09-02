"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Copy, Check, Sparkles } from "lucide-react";

interface ImageMeta {
  url: string;
  prompt: string;
  provider: string;
  createdAt: string;
  originalUrl?: string;
}

export default function GalleryPage() {
  const [images, setImages] = useState<ImageMeta[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/images/list")
      .then((r) => r.json())
      .then((d) => setImages(Array.isArray(d.images) ? d.images : []))
      .catch(() => setImages([]));
  }, []);

  const handleCopyPrompt = async (img: ImageMeta) => {
    try {
      await navigator.clipboard.writeText(img.prompt);
      setCopied(img.url);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-border flex-shrink-0">
        <Link href="/">
          <Button variant="ghost" size="icon-sm" title="返回对话">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <h1 className="text-sm font-medium flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          生成图片历史
        </h1>
        {images && (
          <span className="text-xs text-muted-foreground">{images.length} 张</span>
        )}
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-6">
          {images === null ? (
            <div className="text-center text-sm text-muted-foreground py-20">
              加载中…
            </div>
          ) : images.length === 0 ? (
            <div className="text-center text-sm text-muted-foreground py-20">
              还没有生成过图片。回对话页点右上角图片按钮试试。
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {images.map((img) => (
                <div
                  key={img.url}
                  className="rounded-xl border border-border overflow-hidden bg-card group"
                >
                  <a href={img.url} target="_blank" rel="noopener noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.prompt?.slice(0, 60) || "generated"}
                      className="aspect-square w-full object-cover"
                      loading="lazy"
                    />
                  </a>
                  <div className="p-2.5 flex flex-col gap-1.5">
                    <p
                      className="text-[11px] text-muted-foreground line-clamp-2 leading-snug"
                      title={img.prompt}
                    >
                      {img.prompt}
                    </p>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground/70 shrink-0">
                        {img.provider} ·{" "}
                        {img.createdAt
                          ? new Date(img.createdAt).toLocaleDateString("zh-CN", {
                              month: "short",
                              day: "numeric",
                            })
                          : ""}
                      </span>
                      <button
                        onClick={() => handleCopyPrompt(img)}
                        title="复制提示词"
                        className="p-1 rounded text-muted-foreground/60 hover:text-foreground shrink-0"
                      >
                        {copied === img.url ? (
                          <Check className="size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
