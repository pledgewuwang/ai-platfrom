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
import { ImageIcon, Loader2, Sparkles, Upload, X, ScanSearch } from "lucide-react";
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
  // 旧版本存的 "gemini" 映射到 "gemini"(同一个生成通道)
  const [provider, setProvider] = useState<ImageProvider>(
    settings.apiProvider === "gemini" ? "gemini" : settings.apiProvider
  );
  const [generating, setGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // SVSG V5.2.1 视觉语义分析:对生成图片提问,返回带声明验证的结构化结果
  const [svsgQuery, setSvsgQuery] = useState("");
  const [svsgLoading, setSvsgLoading] = useState(false);
  const [svsgResult, setSvsgResult] = useState<{
    status: string;
    final_answer: string | null;
    claims: Array<{ instance_id: number | null; field: string; value: unknown; confidence: string | null }>;
    human_review_required: boolean;
    error: { message?: string } | null;
  } | null>(null);
  /** 参考图(仅 Gemini 模式生效):本地 data URL 数组 */
  const [referenceImages, setReferenceImages] = useState<{ url: string; mimeType: string }[]>([]);
  const [uploadingRef, setUploadingRef] = useState(false);

  // key 按提供商分开存:切换提供商自动用各自的 key
  const providerKey = settings.apiKeys?.[provider] ?? "";
  const setProviderKey = (key: string) =>
    updateSettings({ apiKeys: { ...(settings.apiKeys ?? {}), [provider]: key } });

  /** 上传参考图(走服务端 upload API 落盘,失败降级为 data URL)
   * 上限 4 张,超出会被服务端拒绝
   */
  const handleRefUpload = async (file: File) => {
    if (referenceImages.length >= 4) {
      toast.error("最多 4 张参考图");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("单张图片不能超过 10MB");
      return;
    }
    setUploadingRef(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(new Error("读取失败"));
        r.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1] || "";
      const res = await fetch("/api/images/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, data: base64, contentType: file.type }),
      });
      const json = await res.json();
      if (!res.ok || !json.url) throw new Error(json.error || "上传失败");
      setReferenceImages((prev) => [...prev, { url: json.url, mimeType: file.type }]);
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : "上传失败";
      toast.error(m);
    } finally {
      setUploadingRef(false);
    }
  };

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
          referenceImages: provider === "gemini" ? referenceImages : [],
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
      // 备选通道只在配了对应 key 时尝试,没 key 的空请求只会白等一次失败
      if (provider === "gemini" && settings.apiKeys?.["dall-e"]) {
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
      } else if (provider === "dall-e" && settings.apiKeys?.flux) {
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
    setSvsgQuery("");
    setSvsgResult(null);
    onOpenChange(false);
  };

  /** SVSG V5.2.1 分析:图片 → L1 编译 → L1.5 验证 → L3 编排 → 结构化答案 */
  const handleSvsgAnalyze = async () => {
    if (!previewUrl || !svsgQuery.trim() || svsgLoading) return;
    setSvsgLoading(true);
    setSvsgResult(null);
    try {
      // 拉取生成图片 → base64(服务端只收 base64,避免 URL 回源问题)
      const imgRes = await fetch(previewUrl);
      if (!imgRes.ok) throw new Error("无法读取生成图片");
      const blob = await imgRes.blob();
      if (blob.size > 8 * 1024 * 1024) throw new Error("图片过大(SVSG 上限 8MB)");
      const b64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(blob);
      });

      const res = await fetch("/api/svsg/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: b64,
          mimeType: blob.type || "image/png",
          query: svsgQuery.trim(),
          apiUrl: settings.svsgApiUrl,
          apiKey: settings.svsgApiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "SVSG 分析失败");
      setSvsgResult(data);
      toast.success("SVSG 分析完成: " + (data.status || "unknown"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "分析失败";
      toast.error("SVSG 分析失败: " + msg);
    } finally {
      setSvsgLoading(false);
    }
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

          {/* 参考图(仅 Gemini 模式生效) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>参考图（仅 Gemini）</Label>
              {referenceImages.length > 0 && (
                <button
                  onClick={() => setReferenceImages([])}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  清空
                </button>
              )}
            </div>
            {referenceImages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {referenceImages.map((ref, idx) => (
                  <div key={idx} className="relative group/ref size-16 rounded-md overflow-hidden border border-border">
                    <img
                      src={ref.url}
                      alt={`ref ${idx + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      onClick={() => setReferenceImages((prev) => prev.filter((_, i) => i !== idx))}
                      className="absolute top-0 right-0 p-0.5 bg-black/60 text-white rounded-bl-md opacity-0 group-hover/ref:opacity-100 transition-opacity"
                      title="删除"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label
              className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground cursor-pointer hover:bg-muted/40 transition-colors"
            >
              <Upload className="size-3.5" />
              {uploadingRef ? "上传中..." : `点击上传（${referenceImages.length}/4）`}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className="hidden"
                disabled={uploadingRef || referenceImages.length >= 4}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  // 批量选择时按剩余容量截断:并发上传都读旧 state,
                  // 不截断会绕过 4 张上限(选 6 张全传)
                  const remaining = 4 - referenceImages.length;
                  files.slice(0, remaining).forEach((f) => handleRefUpload(f));
                  if (files.length > remaining) toast.error("最多 4 张参考图,已忽略多余文件");
                  e.target.value = ""; // 允许重复上传同一文件
                }}
              />
            </label>
            {referenceImages.length > 0 && provider !== "gemini" && (
              <p className="text-[10px] text-yellow-500">⚠️ 当前模型不支持参考图，提交时将被忽略</p>
            )}
          </div>

          {/* Provider Selection */}
          <div className="space-y-2">
            <Label>生成模型</Label>
            <Select
              value={provider}
              onValueChange={(val) => {
                if (val) {
                  setProvider(val as ImageProvider);
                  // imageModel 不再跟随 provider 改写(其语义是模型名如 gpt-image,
                  // 写成 provider 名会误导后续的模型选择逻辑)
                  updateSettings({ apiProvider: val as ImageProvider });
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="flux">⚡ Flux (快速)</SelectItem>
                <SelectItem value="dall-e">🎨 DALL-E 3</SelectItem>
                <SelectItem value="gemini">🖼️ GPT Image 2</SelectItem>
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

          {/* SVSG V5.2.1 视觉语义分析 */}
          {previewUrl && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <Label htmlFor="svsg-query" className="flex items-center gap-1.5">
                <ScanSearch className="size-3.5" />
                SVSG 语义分析
              </Label>
              <div className="flex gap-2">
                <Input
                  id="svsg-query"
                  value={svsgQuery}
                  onChange={(e) => setSvsgQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) handleSvsgAnalyze();
                  }}
                  placeholder="对图片提问,如:图里有几个红色物体?"
                  className="text-sm"
                  disabled={svsgLoading}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSvsgAnalyze}
                  disabled={svsgLoading || !svsgQuery.trim()}
                >
                  {svsgLoading ? <Loader2 className="size-4 animate-spin" /> : "分析"}
                </Button>
              </div>

              {svsgResult && (
                <div className="space-y-2 rounded-md bg-muted/40 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        "rounded px-1.5 py-0.5 font-mono " +
                        (svsgResult.status === "delivered"
                          ? "bg-green-500/15 text-green-600"
                          : svsgResult.status === "delivered_with_review"
                            ? "bg-yellow-500/15 text-yellow-600"
                            : "bg-red-500/15 text-red-500")
                      }
                    >
                      {svsgResult.status}
                    </span>
                    {svsgResult.human_review_required && (
                      <span className="text-yellow-600">⚠️ 需人工复核</span>
                    )}
                  </div>
                  {svsgResult.final_answer && (
                    <p className="text-foreground leading-relaxed">{svsgResult.final_answer}</p>
                  )}
                  {svsgResult.claims?.length > 0 && (
                    <div className="space-y-1">
                      {svsgResult.claims.map((cl, i) => (
                        <div key={i} className="flex items-start gap-1.5 font-mono text-[11px]">
                          <span className="text-muted-foreground shrink-0">
                            {cl.instance_id != null ? "#" + cl.instance_id + " " : ""}
                            {cl.field}:
                          </span>
                          <span className="text-foreground break-all">{String(cl.value)}</span>
                          {cl.confidence && (
                            <span className="text-muted-foreground shrink-0">({cl.confidence})</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {svsgResult.error?.message && (
                    <p className="text-red-500">⚠️ {svsgResult.error.message}</p>
                  )}
                </div>
              )}
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
