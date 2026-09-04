"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  useChatStore,
  chatApiKeyFor,
  resolveRoutedModel,
  type ChatMessage,
} from "@/store/chat-store";
import { MessageBubble } from "@/components/chat/message-bubble";
import { ImageGenerator } from "@/components/chat/image-generator";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { WebExtractor } from "@/components/web-extractor";
import { MediaUpload, type MediaAttachment } from "@/components/chat/media-upload";
import { CodeWorkspace } from "@/components/chat/code-workspace";
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
  Code2,
  ShieldCheck,
  LoaderCircle,
  Feather,
} from "lucide-react";

interface ModelOption {
  id: string;
  label: string;
  group: "cloud" | "local" | "custom" | "top" | "budget";
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
  // 工具记忆只携带最近一条助手消息的:更早的工具记录信息已过时,
  // 每条最长 4000 字符,长对话下逐轮累积白耗大量 token
  let toolNoteUsed = false;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" && m.role !== "assistant") continue;
    let content = m.content;
    if (m.role === "assistant" && m.toolNote && !toolNoteUsed) {
      toolNoteUsed = true;
      content = `${content}\n\n[本轮工具记录] ${m.toolNote.slice(0, 1000)}`;
    }
    if (out.length >= 2 && size + content.length > budget) break;
    out.unshift({ role: m.role, content });
    size += content.length;
  }
  return systemPrompt?.trim()
    ? [{ role: "system", content: systemPrompt.trim() }, ...out]
    : out;
}

/**
 * 逐行读取 SSE 流,每条 data 载荷交给 onData。
 * 处理跨网络分片:缓冲不完整的行,凑齐再解析。
 */
async function readSseStream(res: Response, onData: (data: string) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let sseBuffer = "";

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) return;
    const data = trimmed.slice(6);
    if (data === "[DONE]") return;
    onData(data);
  };

  for (;;) {
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
}

/** 解析一条 SSE data 载荷,返回其中的正文增量(非正文事件返回 null) */
function extractDelta(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    const delta = parsed.choices?.[0]?.delta?.content;
    return typeof delta === "string" ? delta : null;
  } catch {
    return null;
  }
}

export default function Home() {
  // 关键性能:store 里的任何字段变化都会触发此解构所在组件 re-render。
  // 把用于渲染的最少必要字段直接订阅,action 通过 getState() 取以稳定引用,
  // 这样流式期间 streamingSlice 的高频更新不会影响此组件(它只订阅了 conversations / settings 等少量字段)。
  const conversations = useChatStore((s) => s.conversations);
  const currentConversationId = useChatStore((s) => s.currentConversationId);
  const settings = useChatStore((s) => s.settings);
  const loaded = useChatStore((s) => s.loaded);
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const settingsOpen = useChatStore((s) => s.settingsOpen);
  const imageGenOpen = useChatStore((s) => s.imageGenOpen);
  const isGenerating = useChatStore((s) => s.isGenerating);
  const streamingSlice = useChatStore((s) => s.streamingSlice);

  const [inputValue, setInputValue] = useState("");
  const [webExtractorOpen, setWebExtractorOpen] = useState(false);
  const [attachments, setAttachments] = useState<MediaAttachment[]>([]);
  const [models, setModels] = useState<ModelOption[]>(FALLBACK_MODELS);
  const [customModelOpen, setCustomModelOpen] = useState(false);
  const [usage, setUsage] = useState({ prompt: 0, completion: 0 });
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const [systemPromptDraft, setSystemPromptDraft] = useState("");
  // 人机协作编程:右侧工作区开关
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  // 审核模式:针对最近一条编程回复的审核状态/结果
  const [reviewState, setReviewState] = useState<{
    messageId: string;
    loading: boolean;
    result?: string;
    error?: string;
  } | null>(null);
  // 思考提示:流式开始后 2.5 秒内没收到首 token,显示「正在思考…」减少"卡死"错觉
  const [thinkingHint, setThinkingHint] = useState(false);
  const thinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 初始化:设置(localStorage)+ 对话(服务端,含旧数据迁移)
  useEffect(() => {
    void useChatStore.getState()._init();
  }, []);

  // 动态模型列表(云端 + 本地 Ollama)
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.models) && d.models.length > 0) setModels(d.models);
      })
      .catch(() => {});
  }, []);

  // 切换对话时重置本对话用量统计与审核状态
  // (渲染期调整 state,避免 effect 内同步 setState 引发的级联渲染)
  const [prevConvId, setPrevConvId] = useState(currentConversationId);
  if (prevConvId !== currentConversationId) {
    setPrevConvId(currentConversationId);
    setUsage({ prompt: 0, completion: 0 });
    setReviewState(null);
  }

  // 编程子模式切换时联动工作区:协作 → 自动展开,自动化 → 收起
  // (渲染期同步 prev 模式,避免 effect 内 setState 的级联渲染)
  const prevCodeModeKey = settings.codeMode ? settings.codeModeType : "off";
  const [prevWorkspaceKey, setPrevWorkspaceKey] = useState(prevCodeModeKey);
  if (prevWorkspaceKey !== prevCodeModeKey) {
    setPrevWorkspaceKey(prevCodeModeKey);
    setWorkspaceOpen(settings.codeMode && settings.codeModeType === "collab");
  }

  // Auto-focus textarea
  useEffect(() => {
    if (currentConversationId) {
      textareaRef.current?.focus();
    }
  }, [currentConversationId]);

  // 全局快捷键:Cmd/Ctrl+/ 聚焦输入框(ChatGPT 风格)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 不在输入控件中时,Cmd/Ctrl + / 聚焦输入
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 内联当前对话(标题/人设展示等用)
  const currentConversation = currentConversationId
    ? conversations.find((c) => c.id === currentConversationId)
    : undefined;

  // 展示列表记忆化:输入等无关状态变化时保持数组引用稳定,
  // 避免滚动副作用依赖每轮渲染都变化、打字时反复触发滚到底部;
  // 流式期间 streamingSlice 每个 token 变化,memo 按预期重建(只换最后一条)。
  const renderedMessages = useMemo(() => {
    const maxContextTurns = settings.maxContextTurns;
    const all = currentConversation?.messages ?? [];
    const display =
      all.length <= maxContextTurns * 2 ? all : all.slice(-(maxContextTurns * 2));
    // 流式切片:仅在流式期间,当前对话的最后一条消息会被 streamingSlice 覆盖显示,
    // 消费 display 的列表组件不会因 token 推送而反复 re-render
    const lastIsAssistant =
      display.length > 0 && display[display.length - 1].role === "assistant";
    const sliceMatches =
      streamingSlice &&
      streamingSlice.conversationId === currentConversationId &&
      lastIsAssistant;
    return sliceMatches
      ? [...display.slice(0, -1), streamingSlice.message]
      : display;
  }, [currentConversation, settings.maxContextTurns, streamingSlice, currentConversationId]);

  // Auto-scroll to bottom:流式期间每个 token 都触发 scrollIntoView 会重排,
  // 改用 rAF 合并:同一帧内多次 setState 只触发一次滚动。生成中 instant,其余 smooth。
  const scrollPendingRef = useRef<number | null>(null);
  useEffect(() => {
    if (scrollPendingRef.current !== null) return;
    scrollPendingRef.current = requestAnimationFrame(() => {
      scrollPendingRef.current = null;
      messagesEndRef.current?.scrollIntoView({
        behavior: isGenerating ? "auto" : "smooth",
      });
    });
    return () => {
      if (scrollPendingRef.current !== null) {
        cancelAnimationFrame(scrollPendingRef.current);
        scrollPendingRef.current = null;
      }
    };
  }, [renderedMessages, currentConversationId, isGenerating]);

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

      let text = "";
      await readSseStream(res, (data) => {
        text += extractDelta(data) ?? "";
      });

      const title = text
        .trim()
        .replace(/^["'“”《「]+|["'“”》」]+$/g, "")
        .slice(0, 24);
      if (title) useChatStore.getState().updateConversationTitle(convId, title);
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

    // 从 store 实时读取设置:本函数会被「重新生成/编辑重发」等回调捕获,
    // 若用渲染闭包里的 settings 会拿到过期值(改完设置后重发仍用旧配置)
    const settings = useChatStore.getState().settings;

    const content = newUser?.content ?? "";
    const atts = newUser?.attachments ?? [];

    if (newUser) {
      useChatStore.getState().addMessage(convId, {
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
    // 子 Agent 的用户消息:优先本轮输入;重新生成/编辑重发(无 newUser)时
    // 取历史里最后一条用户消息,避免给子 Agent 发空串白跑一次
    const subAgentUserMessage =
      content ||
      [...conversation.messages].reverse().find((m) => m.role === "user")?.content ||
      "";
    let apiMessages = buildApiMessages(
      conversation.messages,
      conversation.systemPrompt,
      settings.tokenBudget
    );

    // URL detection:首发、重新生成、编辑重发都以“本轮真实用户问题”做抓取
    const urlSourceText = content || subAgentUserMessage;
    const urlMatch = urlSourceText.match(/https?:\/\/[^\s]+/);
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
    useChatStore.getState().addMessage(convId, { role: "assistant", content: "" });
    useChatStore.getState().setIsGenerating(true);

    // 提到 try 外:finally 块对 try 内 await 之后的 let 变量在严格 TS 下不可见
    let fullContent = "";
    try {
      abortControllerRef.current = new AbortController();

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          model: settings.modelName,
          enableTools: settings.enableTools,
          toolSettings: {
            maxRounds: settings.toolMaxRounds,
            enabledTools: settings.enabledTools,
            autoRead: settings.toolAutoRead,
            parallel: settings.toolParallel,
            githubToken: settings.githubToken || undefined,
          },
          tokenBudget: settings.tokenBudget,
          codeMode: settings.codeMode,
          codeLanguage: settings.codeLanguage,
          // 温度分区:聊天 0.7 / 编程模式 0.3
          temperature: settings.codeMode ? settings.codeTemperature : settings.temperature,
          // Agent 集群:编程模式下并行多路(每路独立 key/模型,可填相同)
          agentCluster:
            settings.codeMode && settings.agentClusterEnabled
              ? {
                  enabled: true,
                  count: settings.agentClusterCount,
                  apiUrls: settings.agentClusterApiUrls,
                  keys: settings.agentClusterKeys,
                  models: settings.agentClusterModels,
                }
              : undefined,
          // 图片生成 API Key(用户在设置中为当前 imageProvider 配置的 key)
          imageApiKey: settings.apiKeys?.[settings.apiProvider],
          // 子 Agent 分工:仅在用户开启 + 预设非空时附带;
          // 过滤掉角色/提示词为空的不完整预设,避免白跑一次子 Agent 调用
          subAgents: settings.subAgentEnabled && settings.subAgentPresets.length > 0
            ? settings.subAgentPresets
                .filter((p) => p.role.trim() && p.systemPrompt.trim())
                .map((p) => ({
                  id: p.id,
                  role: p.role,
                  systemPrompt: p.systemPrompt,
                  userMessage: subAgentUserMessage,
                  modelName: p.modelName,
                }))
            : undefined,
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
          // 模型智能路由:按路由模式解析实际使用的模型(未开启回落手动选择)
          chatModel: resolveRoutedModel(settings),
          // Agent 记忆模式:unified 时服务端为子 Agent/集群注入共享上下文
          agentMemoryMode: settings.agentMemoryMode,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`Chat API error: ${response.status}`);
      }

      // 标记流式开始:把最后一条 assistant 消息快照进 streamingSlice,
      // 后续每个 token 只更新 slice,不再 setState 整列表 → 列表消息不重渲染
      useChatStore.getState().beginStream(convId);
      // 2.5 秒没收到首 token,显示「正在思考…」弱化"卡死"错觉
      if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current);
      thinkTimerRef.current = setTimeout(() => setThinkingHint(true), 2500);
      let firstTokenReceived = false;
      await readSseStream(response, (data) => {
        let parsed: {
          type?: string;
          label?: string;
          detail?: string;
          status?: string;
          text?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          choices?: { delta?: { content?: string } }[];
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // Skip malformed JSON
        }

        // 工具状态事件:独立 UI,不进正文
        if (parsed.type === "tool_status") {
          if (parsed.status === "running") {
            useChatStore.getState().updateLastAssistantMessage(convId, undefined, {
              appendToolEvent: { label: parsed.label ?? "", status: "running" },
            });
          } else {
            useChatStore.getState().updateLastAssistantMessage(convId, undefined, {
              finishToolEvent: { label: parsed.label ?? "", detail: parsed.detail },
            });
          }
          return;
        }
        if (parsed.type === "tool_summary") {
          useChatStore.getState().updateLastAssistantMessage(convId, undefined, {
            setToolNote: parsed.text,
          });
          return;
        }
        if (parsed.type === "usage" && parsed.usage) {
          const u = parsed.usage;
          setUsage((prev) => ({
            prompt: prev.prompt + (u.prompt_tokens ?? 0),
            completion: prev.completion + (u.completion_tokens ?? 0),
          }));
          return;
        }

        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            if (thinkTimerRef.current) {
              clearTimeout(thinkTimerRef.current);
              thinkTimerRef.current = null;
            }
            if (thinkingHint) setThinkingHint(false);
          }
          fullContent += delta;
          // 高频路径:每个 token 只 push 进 streamingSlice,不重建 conversations 数组
          // 整列表组件不订阅 streamingSlice,自然不会 re-render
          useChatStore.getState().appendStreamToken(convId, delta);
        }
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        toast.info("已停止生成");
      } else {
        const message = error instanceof Error ? error.message : "请求失败";
        toast.error("请求失败: " + message);
        const conv = useChatStore.getState().conversations.find((c) => c.id === convId);
        const existing = conv?.messages.findLast((m) => m.role === "assistant")?.content ?? "";
        useChatStore.getState().updateLastAssistantMessage(
          convId,
          existing
            ? existing + "\n\n⚠️ 错误：" + message + "\n\n请检查模型配置，或在设置中调整。"
            : "⚠️ 错误：" + message + "\n\n请检查模型配置，或在设置中调整。"
        );
      }
    } finally {
      if (thinkTimerRef.current) {
        clearTimeout(thinkTimerRef.current);
        thinkTimerRef.current = null;
      }
      if (thinkingHint) setThinkingHint(false);
      if (fullContent) {
        useChatStore.getState().updateLastAssistantMessage(convId, fullContent);
      } else {
        useChatStore.getState().discardPendingAssistantMessage(convId);
      }
      useChatStore.getState().endStream();
      useChatStore.getState().setIsGenerating(false);
      abortControllerRef.current = null;
      useChatStore.getState().persistConversation(convId);
      void maybeAutoTitle(convId);
    }
  };

  const sendMessage = () => {
    const content = inputValue.trim();
    if (isGenerating) return;
    // 空输入(Enter 键仍可触发)给出反馈,而非静默返回
    if (!content) {
      toast.error("请输入内容后再发送");
      return;
    }

    let convId = currentConversationId;
    if (!convId) {
      convId = useChatStore.getState().createConversation();
    }

    setInputValue("");
    const atts = attachments;
    setAttachments([]);

    void runChat(convId, { content, attachments: atts });
  };

  /** 重新生成:删掉末尾的助手回复,基于同一历史再来一次 */
  const handleRegenerate = useCallback(() => {
    if (!currentConversationId || isGenerating) return;
    const conv = useChatStore.getState().conversations.find(
      (c) => c.id === currentConversationId
    );
    if (!conv) return;
    const lastUser = [...conv.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    useChatStore.getState().truncateMessagesAfter(conv.id, lastUser.id);
    void runChat(conv.id);
  }, [currentConversationId, isGenerating]);
  const handleEditMessage = useCallback((messageId: string, content: string) => {
    if (!currentConversationId || isGenerating) return;
    useChatStore.getState().updateMessage(currentConversationId, messageId, content);
    useChatStore.getState().truncateMessagesAfter(currentConversationId, messageId);
    void runChat(currentConversationId);
  }, [currentConversationId, isGenerating]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 中文输入法选词时的 Enter 不发送,避免吞候选词/误发送
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleImageGenerated = (url: string) => {
    if (!currentConversationId) return;
    useChatStore.getState().addMessage(currentConversationId, {
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
      useChatStore.getState().updateConversationSystemPrompt(currentConversationId, systemPromptDraft);
    }
    setSystemPromptOpen(false);
  };

  // ── 审核模式:针对最近一条编程回复,用独立 key 的模型审核 ──
  const lastMsg = renderedMessages[renderedMessages.length - 1];
  // 流式生成中不显示审核按钮(结果还没出来,审核半成品无意义)
  const showReview =
    settings.codeMode &&
    settings.codeReviewEnabled &&
    !isGenerating &&
    lastMsg &&
    lastMsg.role === "assistant" &&
    lastMsg.content.trim().length > 0;
  // 审核结果只挂在对应消息上:换消息/新回复后旧结果不再显示
  const reviewOfLast = reviewState?.messageId === lastMsg?.id ? reviewState : null;
  const handleReview = async () => {
    if (!lastMsg || !lastMsg.content.trim()) return;
    // 超长代码服务端会截断(审核上限 20000 字符),提前告知避免误审不完整代码
    if (lastMsg.content.length > 12000) {
      toast.warning("代码超过 12000 字符,超出部分将不参与审核(服务端上限 20000)");
    }
    setReviewState({ messageId: lastMsg.id, loading: true, result: undefined, error: undefined });
    try {
      const res = await fetch("/api/code-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: lastMsg.content,
          apiUrl: settings.codeReviewApiUrl || settings.chatApiUrl,
          apiKey: settings.codeReviewApiKey || chatApiKeyFor(settings),
          model: settings.codeReviewModel || settings.chatModel,
          language: settings.codeLanguage,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "审核失败");
      setReviewState({ messageId: lastMsg.id, loading: false, result: data.review });
    } catch (e) {
      setReviewState({
        messageId: lastMsg.id,
        loading: false,
        error: e instanceof Error ? e.message : "审核失败",
      });
    }
  };

  // 自选模型:当前 chatModel 不在已知列表时,作为"自选"项展示
  const knownIds = new Set(models.map((m) => m.id));
  const customModels: ModelOption[] =
    settings.chatModel && !knownIds.has(settings.chatModel)
      ? [{ id: settings.chatModel, label: settings.chatModel, group: "custom" }]
      : [];
  const topModels = models.filter((m) => m.group === "top");
  const budgetModels = models.filter((m) => m.group === "budget" || m.group === "cloud");
  const localModels = models.filter((m) => m.group === "local");

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => useChatStore.getState().setSidebarOpen(false)}
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
              onClick={() => useChatStore.getState().setSidebarOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>

          <ConversationList onMobileClose={() => useChatStore.getState().setSidebarOpen(false)} />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 h-full">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 h-14 border-b border-border flex-shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => useChatStore.getState().setSidebarOpen(!sidebarOpen)}
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

          {settings.codeMode && (
            <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
              <button
                type="button"
                onClick={() => useChatStore.getState().updateSettings({ codeModeType: "auto" })}
                title="自动化编程:直接产出最终代码"
                className={
                  "px-2 py-0.5 rounded text-[11px] transition-colors " +
                  (settings.codeModeType === "auto"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                自动化
              </button>
              <button
                type="button"
                onClick={() => useChatStore.getState().updateSettings({ codeModeType: "collab" })}
                title="人机协作编程:代码进入右侧工作区迭代"
                className={
                  "px-2 py-0.5 rounded text-[11px] transition-colors " +
                  (settings.codeModeType === "collab"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground")
                }
              >
                协作
              </button>
            </div>
          )}

          {settings.codeMode && settings.codeModeType === "collab" && (
            <Button
              variant={workspaceOpen ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => setWorkspaceOpen((o) => !o)}
              title="代码工作区"
            >
              <Code2 className="size-4" />
            </Button>
          )}

          <Link
            href="/writing"
            title="写作台"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Feather className="size-4" />
          </Link>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => useChatStore.getState().setImageGenOpen(true)}
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
            onClick={() => useChatStore.getState().setSettingsOpen(true)}
            title="设置"
          >
            <Settings className="size-4" />
          </Button>
        </header>

        {/* Messages Area */}
        <div className="flex-1 overflow-hidden flex">
          <div className="flex-1 min-w-0 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="max-w-3xl mx-auto px-4 py-6">
              {!loaded ? (
                <div className="flex items-center justify-center h-[50vh] text-sm text-muted-foreground">
                  正在加载对话…
                </div>
              ) : renderedMessages.length === 0 ? (
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
                      useChatStore.getState().createConversation();
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
                  {renderedMessages.map((message, idx) => (
                    <MessageBubble
                      key={message.id}
                      message={message}
                      isLast={idx === renderedMessages.length - 1}
                      onRegenerate={handleRegenerate}
                      onEditMessage={handleEditMessage}
                    />
                  ))}
                </div>
              )}
              {showReview && (
                <div className="mt-3 space-y-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleReview}
                    disabled={reviewOfLast?.loading}
                    className="gap-1.5"
                  >
                    <ShieldCheck className="size-3.5" />
                    {reviewOfLast?.loading ? "审核中…" : "审核"}
                  </Button>
                  {reviewOfLast?.result && (
                    <div className="rounded-lg border border-border bg-card p-3 text-sm whitespace-pre-wrap leading-relaxed">
                      <div className="text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1">
                        <ShieldCheck className="size-3.5" /> 审核意见
                      </div>
                      {reviewOfLast.result}
                    </div>
                  )}
                  {reviewOfLast?.error && (
                    <div className="text-xs text-red-500">⚠️ {reviewOfLast.error}</div>
                  )}
                </div>
              )}
              {thinkingHint && (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  模型正在思考…通常 3-5 秒内有响应,大问题可能更慢
                </div>
              )}
              <div ref={messagesEndRef} />
              </div>
            </ScrollArea>
          </div>
          <CodeWorkspace
            open={workspaceOpen}
            onClose={() => setWorkspaceOpen(false)}
            messages={currentConversation?.messages ?? []}
            isStreaming={isGenerating}
          />
        </div>

        {/* Input Area */}
        <div className="border-t border-border bg-background">
          <div className="max-w-3xl mx-auto px-4 py-3">
            {/* Quick Model Selector */}
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <span className="text-[10px] text-muted-foreground shrink-0">模型:</span>
              <select
                value={settings.chatModel || CUSTOM_MODEL_OPTION}
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
                <optgroup label="🏆 顶级模型">
                  {topModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
                {budgetModels.length > 0 && (
                  <optgroup label="💰 性价比模型">
                    {budgetModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                )}
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
              {settings.routingMode !== "off" && (
                <span
                  title={"模型智能路由已开启: " + resolveRoutedModel(settings)}
                  className="text-[10px] text-primary border border-primary/40 rounded px-1.5 py-0.5"
                >
                  {settings.routingMode === "perfect"
                    ? "完美"
                    : settings.routingMode === "balanced"
                      ? "性价比"
                      : "省钱"}
                  模式
                </span>
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
                  useChatStore.getState().createConversation();
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
        onOpenChange={(v) => useChatStore.getState().setImageGenOpen(v)}
        onImageGenerated={handleImageGenerated}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(v) => useChatStore.getState().setSettingsOpen(v)}
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
