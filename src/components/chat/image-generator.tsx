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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChatStore, type ImageProvider } from "@/store/chat-store";
import { ImageIcon, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

interface ImageGeneratorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImageGenerated: (url: string) => void;
}

export function ImageGenerator({
  open,
  onOpenChange,
  onImageGenerated,
}: ImageGeneratorProps) {
  const { settings, updateSettings } = useChatStore();
  const [prompt, setPrompt] = useState("");
  // 旧版本存的 "gpt-image" 映射到 "gpt-image-2"(同一个生成通道)
  const [provider, setProvider] = useState<ImageProvider>(
    settings.apiProvider === "gpt-image" ? "gpt-image-2" : settings.apiProvider
  );
  const [generating, setGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // key 按提供商分开存:切换提供商自动用各自的 key
  const providerKey = settings.apiKeys?.[provider] ?? "";
  const setProviderKey = (key: string) =>
    updateSettings({ apiKeys: { ...(settings.apiKeys ?? {}), [provider]: key } });

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error("请输入图片描述");
      return;
    }

    if (!providerKey) {
      toast.error(`请先配置 ${provider} 的 API Key`);
      return;
    }

    setGenerating(true);
    setPreviewUrl(null);

    try {
      const response = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          apiKey: providerKey,
          apiProvider: provider,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "图片生成失败");
      }

      setPreviewUrl(data.url);
      onImageGenerated(data.url);
      toast.success("图片生成成功！");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "生成失败";
      // 尝试备选模型
      if (provider === "gpt-image" || provider === "gpt-image-2") {
        toast.error(message + "，尝试 DALL-E 3...");
        try {
          const fallbackResponse = await fetch("/api/image/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: prompt.trim(),
              apiKey: settings.apiKeys?.["dall-e"] ?? "",
              apiProvider: "dall-e",
            }),
          });
          const fallbackData = await fallbackResponse.json();
          if (fallbackResponse.ok && fallbackData.url) {
            setPreviewUrl(fallbackData.url);
            onImageGenerated(fallbackData.url);
            toast.success("使用 DALL-E 3 生成成功！");
            return;
          }
        } catch {
          // fallback also failed
        }
      } else if (provider === "dall-e") {
        toast.error(message + "，尝试 Flux...");
        try {
          const fallbackResponse = await fetch("/api/image/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: prompt.trim(),
              apiKey: settings.apiKeys?.flux ?? "",
              apiProvider: "flux",
            }),
          });
          const fallbackData = await fallbackResponse.json();
          if (fallbackResponse.ok && fallbackData.url) {
            setPreviewUrl(fallbackData.url);
            onImageGenerated(fallbackData.url);
            toast.success("使用 Flux 生成成功！");
            return;
          }
        } catch {
          // fallback also failed
        }
      }
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  };

  const handleClose = () => {
    setPrompt("");
    setPreviewUrl(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="size-5" />
            图片生成
          </DialogTitle>
          <DialogDescription>
            描述你想要生成的图片，AI 将为你创作
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* API Key Config(跟随所选提供商,各存各的) */}
          <div className="space-y-2">
            <Label htmlFor="image-api-key">API Key（{provider}）</Label>
            <Input
              id="image-api-key"
              type="password"
              value={providerKey}
              onChange={(e) => setProviderKey(e.target.value)}
              placeholder={`填入 ${provider} 的 API Key`}
              className="text-sm"
            />
            {!providerKey && (
              <p className="text-xs text-yellow-500">⚠️ 该提供商尚未配置 Key</p>
            )}
          </div>

          {/* Prompt Input */}
          <div className="space-y-2">
            <Label htmlFor="image-prompt">图片描述</Label>
            <textarea
              id="image-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：一只在星空下飞翔的蓝色蝴蝶，梦幻风格..."
              className="flex min-h-[80px] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  handleGenerate();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Ctrl+Enter 快速生成
            </p>
          </div>

          {/* Provider Selection */}
          <div className="space-y-2">
            <Label>生成模型</Label>
            <Select
              value={provider}
              onValueChange={(val) => {
                if (val) {
                  setProvider(val as ImageProvider);
                  updateSettings({ apiProvider: val as ImageProvider, imageModel: val });
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="flux">⚡ Flux (快速)</SelectItem>
                <SelectItem value="dall-e">🎨 DALL-E 3</SelectItem>
                <SelectItem value="gpt-image-2">🖼️ GPT Image 2</SelectItem>
                <SelectItem value="tongyi">🇨🇳 通义万相</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              当前模型: {provider} · 不支持视觉的模型仅生成图片
            </p>
          </div>

          {/* Error handling info */}
          <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-2 text-xs text-blue-600 dark:text-blue-400">
            💡 图片生成失败时会自动尝试备选方案
          </div>

          {/* API Key hint */}
          {!providerKey && (
            <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3 text-sm text-yellow-600 dark:text-yellow-400">
              ⚠️ 未配置 {provider} 的 API Key，每个提供商的 Key 独立保存
            </div>
          )}

          {/* Preview */}
          {previewUrl && (
            <div className="rounded-lg border border-border overflow-hidden">
              <img
                src={previewUrl}
                alt="Generated"
                className="w-full h-auto object-contain max-h-[300px]"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            取消
          </Button>
          <Button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
          >
            {generating ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                生成中...
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                生成图片
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
