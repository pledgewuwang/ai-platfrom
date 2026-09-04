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
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChatStore, ALL_TOOL_NAMES, type ImageProvider, DEFAULT_SETTINGS, type SubAgentPreset, resolveRoutedModel } from "@/store/chat-store";
import { CHAT_PROVIDERS } from "@/lib/models";
import { toast } from "sonner";
import { Settings, Save, RotateCcw, Wrench, Plus, Trash2 } from "lucide-react";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 对话 API 提供商预设(选中即填地址,Key 按域名各存各的) */
/** 图片生成提供商(每个都有自己的 Key 位置) */
const IMAGE_PROVIDERS: { id: ImageProvider; label: string }[] = [
  { id: "gemini", label: "Gemini 3.0 Pro Image" },
  { id: "kling", label: "可灵 (Kling)" },
  { id: "flux", label: "Flux (bfl.ml)" },
  { id: "dall-e", label: "DALL-E 3 (OpenAI)" },
  { id: "tongyi", label: "通义万相 (DashScope)" },
];

/** 工具名称 → 展示名/说明(与 lib/tools.ts 的 AVAILABLE_TOOLS 对应) */
const TOOL_META: Record<string, { label: string; desc: string }> = {
  web_search: { label: "网页搜索", desc: "必应+百度聚合,兜底搜狗/Yahoo,可定向知乎/小红书/微信" },
  fetch_webpage: { label: "读取网页", desc: "抓取指定 URL 的正文内容" },
  search_and_read: { label: "搜索并阅读", desc: "检索后自动阅读前几条结果" },
  github: { label: "GitHub 查询", desc: "搜仓库/读源码/查 issue/看提交历史(公共数据无需登录)" },
  generate_image: { label: "生成图片", desc: "AI 优化提示词后生成图片" },
};

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, updateSettings } = useChatStore();

  const [localSettings, setLocalSettings] = useState(settings);

  // Sync local state when dialog opens
  // (渲染期调整 state,避免 effect 内同步 setState 引发的级联渲染)
  const [wasOpen, setWasOpen] = useState(false);
  if (open && !wasOpen) {
    setWasOpen(true);
    setLocalSettings({ ...settings });
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  const handleSave = () => {
    updateSettings(localSettings);
    toast.success("设置已保存");
    onOpenChange(false);
  };

  const handleReset = () => {
    if (window.confirm("确定要重置所有设置吗?自定义 API Key 与预设将被清除。")) {
      setLocalSettings({ ...DEFAULT_SETTINGS });
      toast.info("设置已恢复默认值,记得点保存");
    }
  };

  // 当前对话地址对应的域名:Key 按域名分别保存
  const chatHost = (() => {
    try {
      return new URL(localSettings.chatApiUrl).hostname;
    } catch {
      return "";
    }
  })();
  const matchedChatProvider = CHAT_PROVIDERS.find((p) => {
    try {
      return new URL(p.url).hostname === chatHost;
    } catch {
      return false;
    }
  });
  const chatKeyValue = localSettings.chatProviderKeys?.[chatHost] ?? "";
  const setChatProviderKey = (key: string) =>
    setLocalSettings({
      ...localSettings,
      chatProviderKeys: {
        ...(localSettings.chatProviderKeys ?? {}),
        [chatHost]: key,
      },
    });

  const toggleTool = (name: string, enabled: boolean) => {
    const prev = localSettings.enabledTools ?? [];
    const next = enabled
      ? [...prev, name]
      : prev.filter((t) => t !== name);
    // 全关等于全开(后端约定:空数组=不过滤),所以最后一个不允许关
    setLocalSettings({
      ...localSettings,
      enabledTools: next.length === 0 ? [...ALL_TOOL_NAMES] : next,
    });
  };

  // ── 子 Agent 预设编辑 ──
  const updatePreset = (id: string, patch: Partial<SubAgentPreset>) => {
    setLocalSettings({
      ...localSettings,
      subAgentPresets: localSettings.subAgentPresets.map((p) =>
        p.id === id ? { ...p, ...patch } : p
      ),
    });
  };
  const addPreset = () => {
    setLocalSettings({
      ...localSettings,
      subAgentPresets: [
        ...localSettings.subAgentPresets,
        {
          id: crypto.randomUUID(),
          role: "",
          systemPrompt: "",
          modelName: "",
        },
      ],
    });
  };
  const removePreset = (id: string) => {
    setLocalSettings({
      ...localSettings,
      subAgentPresets: localSettings.subAgentPresets.filter((p) => p.id !== id),
    });
  };

  // ── Agent 集群:更新第 i 路配置(数组按需扩到 count 长度) ──
  const updateClusterSlot = (
    i: number,
    field: "agentClusterApiUrls" | "agentClusterKeys" | "agentClusterModels",
    value: string
  ) => {
    const arr = [...(localSettings[field] ?? [])];
    while (arr.length < (localSettings.agentClusterCount ?? 1)) arr.push("");
    arr[i] = value;
    setLocalSettings({ ...localSettings, [field]: arr });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="size-5" />
            设置
          </DialogTitle>
          <DialogDescription>配置 API、引擎和对话参数</DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Image Generation API */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">图片生成 API</h3>

            <div className="space-y-2">
              <Label>默认提供商</Label>
              <Select
                value={localSettings.apiProvider}
                onValueChange={(val) =>
                  setLocalSettings({
                    ...localSettings,
                    apiProvider: val as ImageProvider,
                  })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMAGE_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                每个提供商的 Key 独立保存，切换时自动使用各自的 Key
              </p>
              {IMAGE_PROVIDERS.map((p) => (
                <div className="space-y-1.5" key={p.id}>
                  <Label htmlFor={`img-key-${p.id}`}>{p.label} Key</Label>
                  <Input
                    id={`img-key-${p.id}`}
                    type="password"
                    value={localSettings.apiKeys?.[p.id] ?? ""}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        apiKeys: {
                          ...(localSettings.apiKeys ?? {}),
                          [p.id]: e.target.value,
                        },
                      })
                    }
                    placeholder={`${p.label} 的 API Key`}
                    className="text-sm"
                  />
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Chat API Configuration */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">
              对话 API 配置
            </h3>
            <p className="text-xs text-muted-foreground">
              配置云端模型 API，用于 AI 对话。留空则使用本地 HR 引擎。
            </p>

            <div className="space-y-2">
              <Label>提供商</Label>
              <Select
                value={matchedChatProvider?.id ?? "custom"}
                onValueChange={(val) => {
                  const p = CHAT_PROVIDERS.find((x) => x.id === val);
                  if (p) {
                    setLocalSettings({ ...localSettings, chatApiUrl: p.url });
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHAT_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">自定义…</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="chat-api-url">API 地址</Label>
              <Input
                id="chat-api-url"
                value={localSettings.chatApiUrl}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    chatApiUrl: e.target.value,
                  })
                }
                placeholder="https://api.qnaigc.com/v1"
              />
              <p className="text-xs text-muted-foreground">
                OpenAI 兼容的 API 地址。仅允许服务端白名单内的域名，自定义地址需在 .env.local 的 CHAT_API_ALLOWED_HOSTS 中配置
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="chat-api-key">
                API Key{chatHost ? `（${chatHost}）` : ""}
              </Label>
              <Input
                id="chat-api-key"
                type="password"
                value={chatKeyValue}
                onChange={(e) => setChatProviderKey(e.target.value)}
                placeholder="sk-..."
              />
              <p className="text-xs text-muted-foreground">
                每个提供商的 Key 按域名独立保存，切换提供商会自动带上各自的 Key
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="chat-model">对话模型</Label>
              <Input
                id="chat-model"
                value={localSettings.chatModel}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    chatModel: e.target.value,
                  })
                }
                placeholder="openai/gpt-4o-mini"
              />
              <p className="text-xs text-muted-foreground">
                模型名称（如 openai/gpt-4o-mini、claude-opus-5、deepseek-chat）
              </p>
            </div>
          </div>

          <Separator />

          {/* Tool Calling */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
              <Wrench className="size-4" />
              工具调用
            </h3>

            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="enable-tools">启用工具调用</Label>
                <p className="text-xs text-muted-foreground">
                  允许 AI 自主搜索、爬取网页、生成图片（需要模型支持 Function Calling）
                </p>
              </div>
              <Switch
                id="enable-tools"
                checked={localSettings.enableTools}
                onCheckedChange={(checked) =>
                  setLocalSettings({ ...localSettings, enableTools: checked })
                }
              />
            </div>

            {localSettings.enableTools && (
              <>
                <div className="space-y-2">
                  <Label>可用工具</Label>
                  <div className="grid gap-2">
                    {ALL_TOOL_NAMES.map((name) => {
                      const meta = TOOL_META[name];
                      const checked = (localSettings.enabledTools ?? []).includes(name);
                      return (
                        <label
                          key={name}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/40"
                        >
                          <span className="space-y-0.5">
                            <span className="block text-sm">{meta?.label ?? name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {meta?.desc ?? ""}
                            </span>
                          </span>
                          <Switch
                            checked={checked}
                            onCheckedChange={(v) => toggleTool(name, v)}
                            disabled={checked && (localSettings.enabledTools ?? []).length <= 1}
                          />
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    至少保留一个工具；关闭的工具不会再出现在模型的工具列表里
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="tool-max-rounds">工具循环轮数上限</Label>
                    <span className="text-sm text-muted-foreground font-mono">
                      {localSettings.toolMaxRounds}
                    </span>
                  </div>
                  <input
                    id="tool-max-rounds"
                    type="range"
                    min={1}
                    max={10}
                    value={localSettings.toolMaxRounds}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        toolMaxRounds: parseInt(e.target.value),
                      })
                    }
                    className="w-full h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>1</span>
                    <span>10</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    单次回复中最多进行几轮「调用工具 → 继续思考」，防止无限循环
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="tool-auto-read">搜索后自动阅读</Label>
                    <p className="text-xs text-muted-foreground">
                      web_search 后自动抓取前 2 条结果的全文，信息更全但更慢
                    </p>
                  </div>
                  <Switch
                    id="tool-auto-read"
                    checked={localSettings.toolAutoRead}
                    onCheckedChange={(checked) =>
                      setLocalSettings({ ...localSettings, toolAutoRead: checked })
                    }
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="tool-parallel">多工具并行执行</Label>
                    <p className="text-xs text-muted-foreground">
                      同一轮的多个工具调用并行跑，总耗时约等于最慢的一个
                    </p>
                  </div>
                  <Switch
                    id="tool-parallel"
                    checked={localSettings.toolParallel}
                    onCheckedChange={(checked) =>
                      setLocalSettings({ ...localSettings, toolParallel: checked })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="svsg-url">SVSG 视觉语义网关地址</Label>
                  <Input
                    id="svsg-url"
                    type="text"
                    placeholder="http://127.0.0.1:3002"
                    value={localSettings.svsgApiUrl ?? ""}
                    onChange={(e) =>
                      setLocalSettings({ ...localSettings, svsgApiUrl: e.target.value })
                    }
                  />
                  <div className="space-y-2">
                    <Label htmlFor="svsg-key">SVSG API Key（可选）</Label>
                    <Input
                      id="svsg-key"
                      type="password"
                      placeholder="服务端未设置 SVSG_API_KEY 时留空"
                      value={localSettings.svsgApiKey ?? ""}
                      onChange={(e) =>
                        setLocalSettings({ ...localSettings, svsgApiKey: e.target.value })
                      }
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    结构化视觉语义网关(SVSG V5.2.1):图片+问题 → 检测编译 → 声明验证 →
                    带置信度的结构化答案。本地部署后在此配置地址,图片生成界面即可调用分析
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="github-token">GitHub Token（可选）</Label>
                  <Input
                    id="github-token"
                    type="password"
                    placeholder="ghp_...（留空使用匿名访问）"
                    value={localSettings.githubToken ?? ""}
                    onChange={(e) =>
                      setLocalSettings({ ...localSettings, githubToken: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    GitHub 公共数据无需登录；配置 Token 后 API 限额从 60 次/小时提升到
                    5000 次/小时。Token 只保存在本地浏览器
                  </p>
                </div>
              </>
            )}
          </div>

          <Separator />

          {/* Code Mode */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">编程模式</h3>
            <p className="text-xs text-muted-foreground">开启后用最简 system prompt、降低 max_tokens、隐藏中间解释 — 适合日常写代码/改 bug</p>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="code-mode">启用编程模式</Label>
                <p className="text-xs text-muted-foreground">所有发往模型的请求都会附上最小可用的 system 提示</p>
              </div>
              <Switch
                id="code-mode"
                checked={localSettings.codeMode}
                onCheckedChange={(checked) => setLocalSettings({ ...localSettings, codeMode: checked })}
              />
            </div>
            {localSettings.codeMode && (
              <div className="space-y-2">
                <Label htmlFor="code-language">目标语言</Label>
                <Input
                  id="code-language"
                  value={localSettings.codeLanguage}
                  onChange={(e) => setLocalSettings({ ...localSettings, codeLanguage: e.target.value })}
                  placeholder="auto / python / typescript / go / rust / ..."
                />
                <p className="text-xs text-muted-foreground">给模型的「请用 X 语言回答」信号;留 auto 则不指定</p>

                <div className="space-y-1">
                  <Label htmlFor="code-mode-type">编程子模式</Label>
                  <Select
                    value={localSettings.codeModeType}
                    onValueChange={(v) =>
                      setLocalSettings({ ...localSettings, codeModeType: v as "auto" | "collab" })
                    }
                  >
                    <SelectTrigger id="code-mode-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动化编程 — 直接产出最终代码</SelectItem>
                      <SelectItem value="collab">人机协作编程 — 对话旁工作区迭代</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {localSettings.codeModeType === "collab"
                      ? "协作模式:AI 回复的代码块自动进入右侧工作区,可编辑/批准后再采用"
                      : "自动化模式:直接给出最终代码"}
                  </p>
                </div>
              </div>
            )}
          </div>
          <Separator />

          {localSettings.codeMode && (
            <>
              {/* 审核模式 */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">审核模式</h3>
                <p className="text-xs text-muted-foreground">
                  编程结果生成后,用独立 API key 的模型手动审核(编程回复下方出现「审核」按钮)
                </p>
                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="review-enabled">启用审核</Label>
                    <p className="text-xs text-muted-foreground">对编程结果做安全 / 质量审查</p>
                  </div>
                  <Switch
                    id="review-enabled"
                    checked={localSettings.codeReviewEnabled}
                    onCheckedChange={(checked) =>
                      setLocalSettings({ ...localSettings, codeReviewEnabled: checked })
                    }
                  />
                </div>
                {localSettings.codeReviewEnabled && (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-xs">审核 API 地址</Label>
                      <Input
                        value={localSettings.codeReviewApiUrl}
                        onChange={(e) =>
                          setLocalSettings({ ...localSettings, codeReviewApiUrl: e.target.value })
                        }
                        placeholder="https://api.qnaigc.com/v1"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">审核 API Key(独立)</Label>
                      <Input
                        type="password"
                        value={localSettings.codeReviewApiKey}
                        onChange={(e) =>
                          setLocalSettings({ ...localSettings, codeReviewApiKey: e.target.value })
                        }
                        placeholder="sk-..."
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">审核模型</Label>
                      <Input
                        value={localSettings.codeReviewModel}
                        onChange={(e) =>
                          setLocalSettings({ ...localSettings, codeReviewModel: e.target.value })
                        }
                        placeholder="openai/gpt-4o-mini"
                      />
                    </div>
                  </div>
                )}
              </div>
              <Separator />

              {/* Agent 集群 */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-foreground">Agent 集群</h3>
                <p className="text-xs text-muted-foreground">
                  编程模式下并行多路 Agent(最高 4 路)各自产出方案,主模型综合对比后给出最佳实现
                </p>
                <div className="flex items-center justify-between rounded-lg border border-border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="cluster-enabled">启用集群</Label>
                    <p className="text-xs text-muted-foreground">每路可填独立 API key,也可填相同 key</p>
                  </div>
                  <Switch
                    id="cluster-enabled"
                    checked={localSettings.agentClusterEnabled}
                    onCheckedChange={(checked) =>
                      setLocalSettings({ ...localSettings, agentClusterEnabled: checked })
                    }
                  />
                </div>
                {localSettings.agentClusterEnabled && (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <Label className="text-xs">集群路数(1-4)</Label>
                      <Select
                        value={String(localSettings.agentClusterCount)}
                        onValueChange={(v) =>
                          setLocalSettings({ ...localSettings, agentClusterCount: Number(v) })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {n} 路
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {Array.from({ length: localSettings.agentClusterCount }).map((_, i) => (
                      <div key={i} className="space-y-1 rounded-lg border border-border p-2">
                        <span className="text-xs font-medium text-muted-foreground">Agent {i + 1}</span>
                        <Input
                          value={localSettings.agentClusterApiUrls[i] ?? ""}
                          onChange={(e) => updateClusterSlot(i, "agentClusterApiUrls", e.target.value)}
                          placeholder="API 地址(留空用主对话)"
                        />
                        <Input
                          type="password"
                          value={localSettings.agentClusterKeys[i] ?? ""}
                          onChange={(e) => updateClusterSlot(i, "agentClusterKeys", e.target.value)}
                          placeholder="API Key(可填相同)"
                        />
                        <Input
                          value={localSettings.agentClusterModels[i] ?? ""}
                          onChange={(e) => updateClusterSlot(i, "agentClusterModels", e.target.value)}
                          placeholder="模型(留空用主对话)"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <Separator />
            </>
          )}

          {/* 温度分区 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">温度分区</h3>
            <p className="text-xs text-muted-foreground">按场景分别控制模型随机性:对话偏高更自然,编程偏低更确定;子 Agent 分工统一用 0.3</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="chat-temp">对话温度</Label>
                <Input
                  id="chat-temp"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={localSettings.temperature}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      // 清空输入得到 NaN→回落默认 0.7;越界钳到 [0,2]
                      temperature: Math.min(Math.max(Number(e.target.value) || 0.7, 0), 2),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">普通聊天,默认 0.7</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="code-temp">编程模式温度</Label>
                <Input
                  id="code-temp"
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={localSettings.codeTemperature}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      // 清空输入得到 NaN→回落默认 0.3;越界钳到 [0,2]
                      codeTemperature: Math.min(Math.max(Number(e.target.value) || 0.3, 0), 2),
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">代码输出更确定,默认 0.3</p>
              </div>
            </div>
          </div>
          <Separator />

          {/* 模型智能路由 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">模型智能路由</h3>
            <p className="text-xs text-muted-foreground">
              按场景一键切换三档模型:完美=最强模型 / 性价比=中端 / 省钱=最低端;关闭则用手动选择的模型
            </p>
            <div className="space-y-1">
              <Label>路由模式</Label>
              <Select
                value={localSettings.routingMode}
                onValueChange={(v) =>
                  setLocalSettings({
                    ...localSettings,
                    routingMode: v as "off" | "perfect" | "balanced" | "budget",
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">关闭 — 手动选择模型</SelectItem>
                  <SelectItem value="perfect">完美模式 — 选用最强模型</SelectItem>
                  <SelectItem value="balanced">性价比模式 — 选用中端模型</SelectItem>
                  <SelectItem value="budget">省钱模式 — 选用最低端模型</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {localSettings.routingMode !== "off" && (
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label className="text-xs">完美模式模型（最强）</Label>
                  <Input
                    value={localSettings.perfectModel}
                    onChange={(e) =>
                      setLocalSettings({ ...localSettings, perfectModel: e.target.value })
                    }
                    placeholder="如 claude-opus-5 / openai/gpt-4o"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">性价比模式模型（中端）</Label>
                  <Input
                    value={localSettings.balancedModel}
                    onChange={(e) =>
                      setLocalSettings({ ...localSettings, balancedModel: e.target.value })
                    }
                    placeholder="如 openai/gpt-4o-mini"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">省钱模式模型（最低端）</Label>
                  <Input
                    value={localSettings.budgetModel}
                    onChange={(e) =>
                      setLocalSettings({ ...localSettings, budgetModel: e.target.value })
                    }
                    placeholder="如 deepseek-chat"
                  />
                </div>
                <p className="text-[10px] text-muted-foreground">
                  当前生效: {resolveRoutedModel(localSettings)}（留空的档位回落手动选择的模型）
                </p>
              </div>
            )}
          </div>
          <Separator />

          {/* Agent 记忆模式 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">Agent 记忆模式</h3>
            <p className="text-xs text-muted-foreground">
              子 Agent / Agent 集群是否共享主对话的上下文与分级记忆
            </p>
            <div className="space-y-1">
              <Label>记忆模式</Label>
              <Select
                value={localSettings.agentMemoryMode}
                onValueChange={(v) =>
                  setLocalSettings({
                    ...localSettings,
                    agentMemoryMode: v as "isolated" | "unified",
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="isolated">记忆隔离 — 子 Agent 只见分工任务（最省 token）</SelectItem>
                  <SelectItem value="unified">记忆统一 — 注入最近对话与分级记忆</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {localSettings.agentMemoryMode === "unified"
                  ? "统一:子 Agent 带着完整背景作答,结果更贴合上下文,但每路多消耗约 1-3K token"
                  : "隔离:子 Agent 独立作答互不串扰,token 最省（默认）"}
              </p>
            </div>
          </div>
          <Separator />

          {/* Sub-Agent 分工模式 */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">子 Agent 分工模式</h3>
            <p className="text-xs text-muted-foreground">
              发送前把问题并行分发给多个子 Agent 各自作答,结果汇总后交给主模型综合回答。子 Agent 可指定降级模型(便宜小模型)省钱。
            </p>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="subagent-enabled">启用子 Agent 分工</Label>
                <p className="text-xs text-muted-foreground">开启且至少配置 1 个预设后,每次提问自动附带子 Agent</p>
              </div>
              <Switch
                id="subagent-enabled"
                checked={localSettings.subAgentEnabled}
                onCheckedChange={(checked) =>
                  setLocalSettings({ ...localSettings, subAgentEnabled: checked })
                }
              />
            </div>

            {localSettings.subAgentEnabled && (
              <div className="space-y-3">
                {localSettings.subAgentPresets.map((p, i) => (
                  <div key={p.id} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        子 Agent {i + 1}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                        onClick={() => removePreset(p.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">角色名</Label>
                        <Input
                          value={p.role}
                          onChange={(e) => updatePreset(p.id, { role: e.target.value })}
                          placeholder="如:研究员 / 翻译 / 审稿人"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">模型（留空用主模型）</Label>
                        <Input
                          value={p.modelName ?? ""}
                          onChange={(e) => updatePreset(p.id, { modelName: e.target.value })}
                          placeholder="降级模型,如 gpt-4o-mini"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">角色提示词</Label>
                      <Textarea
                        value={p.systemPrompt}
                        onChange={(e) => updatePreset(p.id, { systemPrompt: e.target.value })}
                        placeholder="该子 Agent 的 system 提示词,定义它的分工与输出要求"
                        rows={2}
                      />
                    </div>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={addPreset}>
                  <Plus className="size-3.5" />
                  添加子 Agent
                </Button>
                {localSettings.subAgentPresets.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    尚未配置预设 — 点「添加子 Agent」创建,角色名与提示词均不能为空
                  </p>
                )}
              </div>
            )}
          </div>
          <Separator />

          {/* Context Management */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-foreground">
              上下文管理
            </h3>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="max-turns">
                  滑动窗口大小（显示消息数）
                </Label>
                <span className="text-sm text-muted-foreground font-mono">
                  {localSettings.maxContextTurns}
                </span>
              </div>
              <input
                id="max-turns"
                type="range"
                min={2}
                max={50}
                value={localSettings.maxContextTurns}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    maxContextTurns: parseInt(e.target.value),
                  })
                }
                className="w-full h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>2</span>
                <span>50</span>
              </div>
              <p className="text-xs text-muted-foreground">
                前端显示最近的 N 条消息，完整历史由 HR 引擎自动管理
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="token-budget">Token 预算</Label>
                <span className="text-sm text-muted-foreground font-mono">
                  {localSettings.tokenBudget}
                </span>
              </div>
              <input
                id="token-budget"
                type="range"
                min={512}
                max={32768}
                step={512}
                value={localSettings.tokenBudget}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    tokenBudget: parseInt(e.target.value),
                  })
                }
                className="w-full h-2 rounded-full appearance-none bg-muted cursor-pointer accent-primary"
              />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>512</span>
                <span>32K</span>
              </div>
              <p className="text-xs text-muted-foreground">
                每次请求的 max_tokens（模型单次回复的长度上限）
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="model-name">模型名称</Label>
              <Input
                id="model-name"
                value={localSettings.modelName}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    modelName: e.target.value,
                  })
                }
                placeholder="default"
              />
              <p className="text-xs text-muted-foreground">
                发送给 HR 引擎的模型标识
              </p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleReset} size="sm">
            <RotateCcw className="size-4" />
            重置默认
          </Button>
          <Button onClick={handleSave}>
            <Save className="size-4" />
            保存设置
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
