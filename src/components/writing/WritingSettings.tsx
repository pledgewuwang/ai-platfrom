"use client";

/**
 * 写作台模型设置:与对话平台共用同一套配置与 API 规则。
 * 写入的就是平台设置(chatApiUrl / chatProviderKeys[域名] / chatModel),
 * 调用链路与 /api/chat 相同(cloud-chat:https + 白名单 + 按域名分 Key)。
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
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
import { useChatStore, chatApiKeyFor } from "@/store/chat-store";
import { CHAT_PROVIDERS } from "@/lib/models";
import { toast } from "sonner";

export default function WritingSettings({ onClose }: { onClose: () => void }) {
  const { settings, updateSettings } = useChatStore();
  const [baseUrl, setBaseUrl] = useState(settings.chatApiUrl);
  const [apiKey, setApiKey] = useState(chatApiKeyFor(settings));
  const [model, setModel] = useState(settings.chatModel);

  function pickProvider(providerUrl: string) {
    setBaseUrl(providerUrl);
    // 切换提供商时预填该域名已存的 Key(平台按域名各存各的)
    try {
      const host = new URL(providerUrl).hostname;
      setApiKey(settings.chatProviderKeys[host] ?? "");
    } catch {
      /* 非法 URL 忽略 */
    }
  }

  function save() {
    const url = baseUrl.trim().replace(/\/+$/, "");
    if (!url.startsWith("https://")) {
      toast.error("API 地址需为 https(与对话平台相同的 API 规则)");
      return;
    }
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      toast.error("API 地址不合法");
      return;
    }
    if (!model.trim()) {
      toast.error("请填写模型名");
      return;
    }
    updateSettings({
      chatApiUrl: url,
      chatProviderKeys: { ...settings.chatProviderKeys, [host]: apiKey.trim() },
      chatModel: model.trim(),
    });
    toast.success("模型配置已保存(对话平台同步生效)");
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>写作台模型设置</DialogTitle>
          <DialogDescription>
            与对话平台共用同一套模型配置与 API 规则(cloud-chat:https + 域名白名单 + 按域名分 Key)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>提供商</Label>
            <Select value={baseUrl} onValueChange={(v) => v && pickProvider(v)}>
              <SelectTrigger>
                <SelectValue placeholder="选择提供商(自动填地址)" />
              </SelectTrigger>
              <SelectContent>
                {CHAT_PROVIDERS.map((p) => (
                  <SelectItem key={p.id} value={p.url}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="writing-base-url">API 地址(OpenAI 兼容)</Label>
            <Input
              id="writing-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.qnaigc.com/v1"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="writing-api-key">API Key</Label>
            <Input
              id="writing-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…(按域名保存,与对话平台共享)"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="writing-model">模型名</Label>
            <Input
              id="writing-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="如 openai/gpt-4o-mini、glm-4.6、deepseek-chat"
            />
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            新供应商域名需加入 .env.local 的 CHAT_API_ALLOWED_HOSTS 白名单(与对话 API
            完全相同的规则);配置对对话平台与写作台同时生效。
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
