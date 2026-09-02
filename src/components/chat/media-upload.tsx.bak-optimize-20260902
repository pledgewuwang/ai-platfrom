"use client";

import React, { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon, Video, X, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { getModelVisionConfig } from "@/lib/vision";
import { useChatStore } from "@/store/chat-store";

export interface MediaAttachment {
  type: "image" | "video";
  mimeType: string;
  data: string; // base64(发给模型做视觉理解)
  filename: string;
  preview?: string; // 图片:服务端持久 URL(/generated/...),历史记录里能长期显示
}

interface MediaUploadProps {
  onAttach: (attachments: MediaAttachment[]) => void;
  attachments: MediaAttachment[];
  onRemove: (index: number) => void;
}

export function MediaUpload({
  onAttach,
  attachments,
  onRemove,
}: MediaUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { settings } = useChatStore();

  const visionConfig = getModelVisionConfig(settings.chatModel);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    const newAttachments: MediaAttachment[] = [];

    for (const file of files) {
      // 检查文件类型
      const isImage = file.type.startsWith("image/");
      const isVideo = file.type.startsWith("video/");

      if (!isImage && !isVideo) {
        toast.error(`${file.name}: 不支持的文件类型`);
        continue;
      }

      // 检查文件大小（图片 10MB，视频 50MB）
      const maxSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
      if (file.size > maxSize) {
        toast.error(`${file.name}: 文件过大（最大 ${isVideo ? "50MB" : "10MB"}）`);
        continue;
      }

      try {
        const base64 = await fileToBase64(file);
        let preview: string | undefined;

        if (isImage) {
          // 图片落服务端,拿到持久 URL —— 刷新/换设备后历史里的图还能显示
          preview = await uploadImage(file.name, base64);
        }

        newAttachments.push({
          type: isImage ? "image" : "video",
          mimeType: file.type,
          data: base64,
          filename: file.name,
          preview,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "读取失败";
        toast.error(`${file.name}: ${message}`);
      }
    }

    if (newAttachments.length > 0) {
      onAttach(newAttachments);

      // 显示视觉能力警告
      if (!visionConfig.supportsVision) {
        toast.warning("当前模型不支持图片/视频理解，将以文字降级处理", {
          duration: 5000,
        });
      }
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setUploading(false);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        title={uploading ? "上传中..." : "上传图片/视频"}
        className="text-muted-foreground hover:text-foreground"
      >
        {uploading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ImageIcon className="size-4" />
        )}
      </Button>

      {/* 附件预览 */}
      {attachments.length > 0 && (
        <div className="flex items-center gap-1 ml-1">
          {attachments.map((att, i) => (
            <div
              key={i}
              className="relative group w-8 h-8 rounded-md overflow-hidden border border-border"
            >
              {att.type === "image" && att.preview ? (
                <img
                  src={att.preview}
                  alt={att.filename}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-muted">
                  <Video className="size-3 text-muted-foreground" />
                </div>
              )}
              <button
                onClick={() => onRemove(i)}
                className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              >
                <X className="size-3 text-white" />
              </button>
            </div>
          ))}
          {!visionConfig.supportsVision && (
            <span title="当前模型不支持视觉"><AlertTriangle className="size-3 text-yellow-500" /></span>
          )}
        </div>
      )}
    </div>
  );
}

async function uploadImage(filename: string, base64: string): Promise<string> {
  const res = await fetch("/api/images/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, data: base64 }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `上传失败 (${res.status})`);
  }
  const data = await res.json();
  return data.url as string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove data:image/xxx;base64, prefix
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
