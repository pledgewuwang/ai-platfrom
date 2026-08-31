"use client";

import React, { useEffect, useRef, useState } from "react";
import { useChatStore, chatApiKeyFor, type ChatMessage } from "@/store/chat-store";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ImageGenerator } from "@/components/chat/image-generator";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { WebExtractor } from "@/components/web-extractor";
import { MediaUpload, type MediaAttachment } from "@/components/chat/media-upload";
import { toast } from "sonner";
import { ConversationList } from "@/components/sidebar/conversation-list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Send,
  ImageIcon,
  Plus,
  Settings,
  Menu,
  X,
  Sparkles,
  Globe,
  SlidersHorizontal,
} from "lucide-react";

interface ModelOption {
  id: string;
  label: string;
  group: "cloud" | "local" | "custom";
}

const CUSTOM_MODEL_OPTION = "__custom__";

const FALLBACK_MODELS: ModelOption[] = [
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini", group: "cloud" },
  { id: "openai/gpt-4o", label: "GPT-4o", group: "cloud" },
  { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini", group: "cloud" },
  { id: "claude-opus-5", label: "Claude Opus 5", group: "cloud" },
  { id: "deepseek-chat", label: "DeepSeek", group: "cloud" },
  { id: "glm-4.6", label: "GLM-4.6", group: "cloud" },
];

/**
 * 组装发给 API 的历史:
 * - 输入侧按字符预算截断(粗略对应 token),永远保留最近的消息
 * - 每对话 system prompt 放最前
 * - 助手消息带的工具记忆(toolNote)一并回传,避免模型重复搜索
 */
function buildApiMessages(
  msgs: ChatMessage[],
  systemPrompt: string | undefined,
  tokenBudget: number
): { role: "user" | "assistant" | "system"; content: string }[] {
  const budget = Math.max(8000, tokenBudget * 3);
  const out: { role: "user" | "assistant"; content: string }[] = [];
  let size = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    const content = m.toolNote
      ? `${m.content}\n\n[本轮工具记录] ${m.toolNote}`
      : m.content;
    if (out.length >= 2 && size + content.length > budget) break;
    out.unshift({ role: m.role, content });
    size += content.length;
  }
  return systemPrompt?.trim()
    ? [{ role: "system", content: systemPrompt.trim() }, ...out]
    : out;
}

export default function Home() {
  const {
    conversations,
    currentConversationId,
    settings,
    loaded,
    sidebarOpen,
    settingsOpen,
    imageGenOpen,
    isGenerating,
    createConversation,
    addMessage,
    updateLastAssistantMessage,
    updateMessage,
    truncateMessagesAfter,
    updateConversationTitle,
    updateConversationSystemPrompt,
    persistConversation,
    setSidebarOpen,
    setSettingsOpen,
    setImageGenOpen,
    setIsGenerating,
    getCurrentConversation,
    getDisplayMessages,
    _init,
  } = useChatStore();

  const [inputValue, setInputValue] = useState("");
  const [webExtractorOpen, setWebExtractorOpen] = useState(false);
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
  const [customModelOpen, setCustomModelOpen] = useState(false);
  const [usage, setUsage] = useState({ prompt: 0, completion: 0 });
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 初始化:设置(localStorage)+ 对话(服务端,含旧数据迁移)
  useEffect(() => {
    void _init();
  }, [_init]);

  // 动态模型列表(云端 + 本地 Ollama)
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.models) && d.models.length > 0) setModels(d.models);
      })
      .catch(() => {});
  }, []);

  // 切换对话时重置本对话用量统计
  useEffect(() => {
    setUsage({ prompt: 0, completion: 0 });
  }, [currentConversationId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversations, currentConversationId]);

  // Auto-focus textarea
  useEffect(() => {
    if (currentConversationId) {
      textareaRef.current?.focus();
    }
  }, [currentConversationId]);

  const currentConversation = getCurrentConversation();
  const displayMessages = getDisplayMessages();

  /** 流式结束后用小请求自动起标题(仅默认标题时) */
  const maybeAutoTitle = async (convId: string) => {
    const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (!conv) return;
    const firstUser = conv.messages.find((m) => m.role === "user");
    const firstAssistant = conv.messages.find(
      (m) => m.role === "assistant" && m.content.trim().length > 0
    );
    if (!firstUser || !firstAssistant) return;

    const defaultTitle =
      firstUser.content.slice(0, 30) + (firstUser.content.length > 30 ? "..." : "");
    if (conv.title !== "新对话" && conv.title !== defaultTitle) return;

    const s = useChatStore.getState().settings;
    const prompt = `请为下面这段对话生成一个简短标题（不超过12个字，直接输出标题文字，不要标点、不要引号、不要解释）：\n\n用户：${firstUser.content.slice(0, 200)}\n助手：${firstAssistant.content.slice(0, 200)}`;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          enableTools: false,
          tokenBudget: 200,
          chatApiUrl: s.chatModel.startsWith("ollama/") ? undefined : s.chatApiUrl,
          chatApiKey: chatApiKeyFor(s),
          chatModel: s.chatModel,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok || !res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let text = "";

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) return;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) text += delta;
        } catch {
          // skip
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";
        lines.forEach(processLine);
      }
      if (sseBuffer) processLine(sseBuffer);

      const title = text
        .trim()
        .replace(/^["'“”《「]+|["'“”》」]+$/g, "")
        .slice(0, 24);
      if (title) updateConversationTitle(convId, title);
    } catch {
      // 起标题失败无所谓
    }
  };

  /**
   * 核心聊天流程(发送 / 重新生成 / 编辑重发共用)。
   * newUser 为空时,直接用现有历史继续生成。
   */
  const runChat = async (
    convId: string,
    newUser?: { content: string; attachments: MediaAttachment[] }
  ) => {
    if (useChatStore.getState().isGenerating) return;

    const content = newUser?.content ?? "";
    const atts = newUser?.attachments ?? [];

    if (newUser) {
      addMessage(convId, {
        role: "user",
        content,
        imageUrls: atts
          .filter((a) => a.type === "image")
          .map((a) => a.preview)
          .filter((u): u is string => !!u),
      });
    }

    // 组装 API 消息(在加入占位 assistant 之前快照)
    const conversation = useChatStore.getState().conversations.find((c) => c.id === convId);
    if (!conversation) return;
    let apiMessages = buildApiMessages(
      conversation.messages,
      conversation.systemPrompt,
      settings.tokenBudget
    );

    // URL detection: auto-extract web content into context
    const urlMatch = content.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      try {
        const crawlRes = await fetch("/api/crawl", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: urlMatch[0],
            options: { maxContentLength: 8000 },
            format: "llm",
          }),
        });
        const crawlData = await crawlRes.json();
        if (crawlData.success && crawlData.data) {
          apiMessages = [
            { role: "system", content: `以下是用户提供的 URL 网页内容:\n\n${crawlData.data}` },
            ...apiMessages,
          ];
          toast.info("已自动提取网页内容");
        }
      } catch (e) {
        console.warn("[URL Extract] Failed:", e);
      }
    }

    // 占位 assistant 消息,流式内容往里填
    addMessage(convId, { role: "assistant", content: "" });
    setIsGenerating(true);

    try {
      abortControllerRef.current = new AbortController();

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          model: settings.modelName,
          enableTools: settings.enableTools,
          tokenBudget: settings.tokenBudget,
          attachments:
            atts.length > 0
              ? atts.map((a) => ({
                  type: a.type,
                  mimeType: a.mimeType,
                  data: a.data,
                  isUrl: false,
                  filename: a.filename,
                }))
              : undefined,
          chatApiUrl: settings.chatModel.startsWith("ollama/")
            ? "http://localhost:11434"
            : settings.chatApiUrl,
          chatApiKey: chatApiKeyFor(settings),
          chatModel: settings.chatModel,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`Chat API error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let fullContent = "";
      // SSE 事件可能跨网络分片:缓冲不完整的行,凑齐再解析
      let sseBuffer = "";

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) return;

        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data);

          // 工具状态事件:独立 UI,不进正文
          if (parsed.type === "tool_status") {
            if (parsed.status === "running") {
              updateLastAssistantMessage(convId, undefined, {
                appendToolEvent: { label: parsed.label, status: "running" },
              });
            } else {
              updateLastAssistantMessage(convId, undefined, {
                finishToolEvent: { label: parsed.label, detail: parsed.detail },
              });
            }
            return;
          }
          if (parsed.type === "tool_summary") {
            updateLastAssistantMessage(convId, undefined, {
              setToolNote: parsed.text,
            });
            return;
          }
          if (parsed.type === "usage" && parsed.usage) {
            setUsage((u) => ({
              prompt: u.prompt + (parsed.usage.prompt_tokens ?? 0),
              completion: u.completion + (parsed.usage.completion_tokens ?? 0),
            }));
            return;
          }

          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            updateLastAssistantMessage(convId, fullContent);
          }
        } catch {
          // Skip malformed JSON
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? ""; // 最后一段可能不完整,留到下一轮

        for (const line of lines) {
          processLine(line);
        }
      }
      if (sseBuffer) processLine(sseBuffer);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        // User cancelled - keep what we have
      } else {
        const message = error instanceof Error ? error.message : "请求失败";
        const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
        const existing = conv?.messages.findLast((m) => m.role === "assistant")?.content ?? "";
        updateLastAssistantMessage(
          convId,
          `${existing}\n\n⚠️ 错误：${message}\n\n请检查模型配置，或在设置中调整。`
        );
      }
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
      persistConversation(convId);
      void maybeAutoTitle(convId);
    }
  };

  const sendMessage = () => {
    const content = inputValue.trim();
    if (!content || isGenerating) return;

    let convId = currentConversationId;
    if (!convId) {
      convId = createConversation();
    }

    setInputValue("");
    const atts = attachments;
    setAttachments([]);

    void runChat(convId, { content, attachments: atts });
  };

  /** 重新生成:删掉末尾的助手回复,基于同一历史再来一次 */
  const handleRegenerate = () => {
    if (!currentConversationId || isGenerating) return;
    const conv = useChatStore.getState().conversations.find(
      (c) => c.id === currentConversationId
    );
    if (!conv) return;
    const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    truncateMessagesAfter(conv.id, lastUser.id);
    void runChat(conv.id);
  };

  /** 编辑用户消息:改内容、删掉之后的回复,从该处重新生成 */
  const handleEditMessage = (messageId: string, content: string) => {
    if (!currentConversationId || isGenerating) return;
    updateMessage(currentConversationId, messageId, content);
    truncateMessagesAfter(currentConversationId, messageId);
    void runChat(currentConversationId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleImageGenerated = (url: string) => {
    if (!currentConversationId) return;
    addMessage(currentConversationId, {
      role: "assistant",
      content: "🎨 图片已生成",
      imageUrls: [url],
    });
  };

  const stopGeneration = () => {
    abortControllerRef.current?.abort();
  };

  const openSystemPrompt = () => {
    setSystemPromptDraft(currentConversation?.systemPrompt ?? "");
    setSystemPromptOpen(true);
  };

  const saveSystemPrompt = () => {
    if (currentConversationId) {
      updateConversationSystemPrompt(currentConversationId, systemPromptDraft);
    }
    setSystemPromptOpen(false);
  };

  // 自选模型:当前 chatModel 不在已知列表时,作为"自选"项展示
  const knownIds = new Set(models.map((m) => m.id));
  const customModels: ModelOption[] =
    settings.chatModel && !knownIds.has(settings.chatModel)
      ? [{ id: settings.chatModel, label: settings.chatModel, group: "custom" }]
      : [];
  const cloudModels = models.filter((m) => m.group === "cloud");
  const localModels = models.filter((m) => m.group === "local");

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed md:relative z-40 md:z-auto
          w-72 h-full bg-card border-r border-border
          transform transition-transform duration-200 ease-in-out
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          md:translate-x-0
        `}
      >
        <div className="flex flex-col h-full">
          {/* Sidebar header */}
          <div className="flex items-center justify-between p-4 border-b border-border">
            <h1 className="font-semibold text-sm flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              AI Platform
            </h1>
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>

          <ConversationList onMobileClose={() => setSidebarOpen(false)} />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 h-full">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 h-14 border-b border-border flex-shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="侧边栏"
          >
            <Menu className="size-4" />
          </Button>

          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium truncate">
              {currentConversation?.title || "新对话"}
            </h2>
          </div>

          {currentConversation?.systemPrompt?.trim() && (
            <span
              title="本对话已设置系统提示词"
              className="text-[10px] text-primary border border-primary/40 rounded px-1.5 py-0.5"
            >
              人设
            </span>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={openSystemPrompt}
            disabled={!currentConversationId}
            title="系统提示词 / 人设"
          >
            <SlidersHorizontal className="size-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setImageGenOpen(true)}
            title="图片生成"
          >
            <ImageIcon className="size-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setWebExtractorOpen(true)}
            title="网页提取"
          >
            <Globe className="size-4" />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSettingsOpen(true)}
            title="设置"
          >
            <Settings className="size-4" />
          </Button>
        </header>

        {/* Messages Area */}
        <div className="flex-1 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="max-w-3xl mx-auto px-4 py-6">
              {!loaded ? (
                <div className="flex items-center justify-center h-[50vh] text-sm text-muted-foreground">
                  正在加载对话…
                </div>
              ) : displayMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[50vh] text-center">
                  <Sparkles className="size-12 text-muted-foreground/30 mb-4" />
                  <h3 className="text-lg font-medium text-muted-foreground mb-2">
                    开始对话吧
                  </h3>
                  <p className="text-sm text-muted-foreground/60 max-w-md mb-6">
                    输入任何问题开始对话，或点击下方按钮新建。
                  </p>
                  <Button
                    onClick={() => {
                      const id = createConversation();
                      setTimeout(() => textareaRef.current?.focus(), 100);
                    }}
                    size="lg"
                    className="gap-2"
                  >
                    <Plus className="size-4" />
                    新建对话
                  </Button>
                </div>
              ) : (
                <div className="divide-y divide-transparent">
                  {displayMessages.map((message, idx) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isLast={idx === displayMessages.length - 1}
                      onRegenerate={handleRegenerate}
                      onEditMessage={handleEditMessage}
                    />
                  ))}
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>
        </div>

        {/* Input Area */}
        <div className="border-t border-border bg-background">
          <div className="max-w-3xl mx-auto px-4 py-3">
            {/* Quick Model Selector */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[10px] text-muted-foreground shrink-0">模型:</span>
              <select
                value={
                  customModels.length > 0 || !settings.chatModel
                    ? settings.chatModel || CUSTOM_MODEL_OPTION
                    : settings.chatModel
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === CUSTOM_MODEL_OPTION) {
                    setCustomModelOpen(true);
                    return;
                  }
                  setCustomModelOpen(false);
                  useChatStore.getState().updateSettings({ chatModel: v });
                }}
                className="text-[11px] bg-muted/50 border border-input rounded-md px-2 py-1 max-w-[200px] truncate focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <optgroup label="☁️ 云端">
                  {cloudModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
                {localModels.length > 0 && (
                  <optgroup label="🖥️ 本地 Ollama">
                    {localModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                {customModels.length > 0 && (
                  <optgroup label="✏️ 自选">
                    {customModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value={CUSTOM_MODEL_OPTION}>✏️ 输入自定义模型 ID…</option>
              </select>
              {customModelOpen && (
                <input
                  value={settings.chatModel}
                  onChange={(e) =>
                    useChatStore.getState().updateSettings({ chatModel: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setCustomModelOpen(false);
                  }}
                  onBlur={() => setCustomModelOpen(false)}
                  placeholder="如 openai/gpt-5、deepseek-v4-pro、ollama/llama3"
                  className="text-[11px] bg-muted/50 border border-input rounded-md px-2 py-1 w-52 focus:outline-none focus:ring-1 focus:ring-ring"
                  autoFocus
                />
              )}
              {!chatApiKeyFor(settings) &&
                !settings.chatModel.startsWith("ollama/") && (
                  <span className="text-[10px] text-yellow-500">⚠️ 未配置 API Key</span>
                )}
            </div>
            <div className="flex gap-2 items-end">
              <div className="flex-1 relative">
                <MediaUpload
                  onAttach={(newAtts) => setAttachments([...attachments, ...newAtts])}
                  attachments={attachments}
                  onRemove={(i) => setAttachments(attachments.filter((_, idx) => idx !== i))}
                />
                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    currentConversationId
                      ? "输入消息... (Enter 发送, Shift+Enter 换行)"
                      : "开始新对话..."
                  }
                  rows={1}
                  className="flex min-h-[44px] max-h-[200px] w-full rounded-xl border border-input bg-muted/30 px-4 py-3 pr-12 text-sm resize-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  style={{
                    height: "auto",
                    minHeight: "44px",
                  }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
                  }}
                />
              </div>

              {isGenerating ? (
                <Button
                  onClick={stopGeneration}
                  variant="destructive"
                  size="icon"
                  className="h-11 w-11 rounded-xl flex-shrink-0"
                  title="停止生成"
                >
                  <div className="size-3 bg-current rounded-sm" />
                </Button>
              ) : (
                <Button
                  onClick={sendMessage}
                  disabled={!inputValue.trim()}
                  size="icon"
                  className="h-11 w-11 rounded-xl flex-shrink-0"
                  title="发送"
                >
                  <Send className="size-4" />
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between mt-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] text-muted-foreground gap-1"
                onClick={() => {
                  createConversation();
                  setTimeout(() => textareaRef.current?.focus(), 100);
                }}
              >
                <Plus className="size-3" />
                新对话
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {usage.prompt + usage.completion > 0 &&
                  `本对话 ${(usage.prompt + usage.completion).toLocaleString()} tokens · `}
                AI Platform · {currentConversation?.modelId || settings.chatModel || "未配置模型"}
              </span>
            </div>
          </div>
        </div>
      </main>

      {/* Dialogs */}
      <ImageGenerator
        open={imageGenOpen}
        onOpenChange={setImageGenOpen}
        onImageGenerated={handleImageGenerated}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      <WebExtractor
        open={webExtractorOpen}
        onOpenChange={setWebExtractorOpen}
        onInsertToChat={(text) => setInputValue(text)}
      />

      {/* 系统提示词 / 人设 */}
      <Dialog open={systemPromptOpen} onOpenChange={setSystemPromptOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <SlidersHorizontal className="size-5" />
              系统提示词 / 人设
            </DialogTitle>
            <DialogDescription>
              仅对当前对话生效，会作为 system 消息最先发给模型
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={systemPromptDraft}
            onChange={(e) => setSystemPromptDraft(e.target.value)}
            rows={6}
            placeholder="例如：你是一位严谨的技术顾问，回答用简体中文，代码给完整示例……"
            className="w-full rounded-lg border border-input bg-muted/30 px-3 py-2 text-sm resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSystemPromptOpen(false)}>
              取消
            </Button>
            <Button onClick={saveSystemPrompt}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
