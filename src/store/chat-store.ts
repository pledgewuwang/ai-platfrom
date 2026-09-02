import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";

/* ── Types ─────────────────────────────────────────────── */

export interface ToolEvent {
  label: string;
  detail?: string;
  status?: "running" | "done";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  imageUrls?: string[];
  /** 本轮的工具调用记录(前端折叠展示) */
  toolEvents?: ToolEvent[];
  /** 工具调用摘要,随历史回传给模型(避免重复搜索) */
  toolNote?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  modelId?: string; // 对话使用的模型（可选，覆盖全局设置）
  systemPrompt?: string; // 每对话系统提示词/人设
}

export type ImageProvider = "flux" | "dall-e" | "gemini" | "kling" | "tongyi";

export interface Settings {
  apiProvider: ImageProvider;
  /** 图片生成:每个提供商各自的 key(切换提供商自动带各自的 key) */
  apiKeys: Partial<Record<ImageProvider, string>>;
  chatApiUrl: string;  // 对话 API 地址（云端模型）
  /** 对话 API:按提供商域名各存一个 key */
  chatProviderKeys: Record<string, string>;
  chatModel: string;   // 对话模型名称(可自选任意 ID)
  imageModel: string;  // 图片生成模型
  enableTools: boolean; // 启用 AI 工具调用（搜索/爬取）
  maxContextTurns: number; // 滑动窗口大小
  tokenBudget: number;    // 每次请求的 max_tokens
  modelName: string;
}

export interface ChatState {
  // Conversations
  conversations: Conversation[];
  currentConversationId: string | null;
  loaded: boolean; // 服务端历史是否已加载完成

  // Settings
  settings: Settings;

  // UI State
  sidebarOpen: boolean;
  settingsOpen: boolean;
  imageGenOpen: boolean;
  isGenerating: boolean;

  // Actions
  _init: () => Promise<void>;
  persistConversation: (id: string) => void;

  createConversation: () => string;
  deleteConversation: (id: string) => void;
  setCurrentConversation: (id: string) => void;
  updateConversationTitle: (id: string, title: string) => void;
  updateConversationSystemPrompt: (id: string, systemPrompt: string) => void;

  addMessage: (conversationId: string, message: Omit<ChatMessage, "id" | "timestamp">) => void;
  updateLastAssistantMessage: (
    conversationId: string,
    content?: string,
    extras?: {
      appendToolEvent?: ToolEvent;
      finishToolEvent?: { label: string; detail?: string };
      setToolNote?: string;
    }
  ) => void;
  updateMessage: (conversationId: string, messageId: string, content: string) => void;
  truncateMessagesAfter: (conversationId: string, messageId: string) => void;

  updateSettings: (settings: Partial<Settings>) => void;
  setSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setImageGenOpen: (open: boolean) => void;
  setIsGenerating: (generating: boolean) => void;

  // Computed
  getCurrentConversation: () => Conversation | undefined;
  getDisplayMessages: () => ChatMessage[];
}

/* ── Defaults ──────────────────────────────────────────── */

const DEFAULT_SETTINGS: Settings = {
  apiProvider: "flux",
  apiKeys: {},
  chatApiUrl: "https://api.qnaigc.com/v1",
  chatProviderKeys: {},
  chatModel: "openai/gpt-4o-mini",
  imageModel: "gpt-image",
  enableTools: true,
  maxContextTurns: 10,
  tokenBudget: 4096,
  modelName: "default",
};

/* ── Settings:仍存 localStorage(设备各自的密钥配置) ──── */

const SETTINGS_KEY = "ai-platform-settings";
const LEGACY_CONVERSATIONS_KEY = "ai-platform-conversations";

function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const data = localStorage.getItem(SETTINGS_KEY);
    if (!data) return DEFAULT_SETTINGS;
    const saved = JSON.parse(data) as Record<string, unknown>;
    const merged: Settings = { ...DEFAULT_SETTINGS, ...(saved as Partial<Settings>) };

    // 兼容旧版单 key 设置,迁移到按提供商分存
    if (merged.apiProvider === ("gemini" as ImageProvider)) {
      merged.apiProvider = "gemini";
    }
    if (typeof saved.apiKey === "string" && saved.apiKey) {
      const provider = merged.apiProvider;
      merged.apiKeys = { ...merged.apiKeys, [provider]: saved.apiKey };
    }
    if (typeof saved.chatApiKey === "string" && saved.chatApiKey && merged.chatApiUrl) {
      try {
        const host = new URL(merged.chatApiUrl).hostname;
        merged.chatProviderKeys = { ...merged.chatProviderKeys, [host]: saved.chatApiKey };
      } catch {
        // URL 无效时跳过迁移
      }
    }

    merged.apiKeys = merged.apiKeys ?? {};
    merged.chatProviderKeys = merged.chatProviderKeys ?? {};
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings: Settings) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or unavailable
  }
}

/** 当前对话提供商(按 chatApiUrl 域名)对应的 key */
export function chatApiKeyFor(settings: Settings): string {
  try {
    return settings.chatProviderKeys[new URL(settings.chatApiUrl).hostname] ?? "";
  } catch {
    return "";
  }
}

/** 读取旧版 localStorage 对话(仅用于一次性迁移到服务端) */
function loadLegacyConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(LEGACY_CONVERSATIONS_KEY);
    return data ? (JSON.parse(data) as Conversation[]) : [];
  } catch {
    return [];
  }
}

/* ── 服务端同步 ────────────────────────────────────────── */

async function persistToServer(conversation: Conversation) {
  try {
    await fetch(`/api/conversations/${conversation.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(conversation),
    });
  } catch (e) {
    console.warn("[Store] 保存对话到服务端失败:", e);
  }
}

async function deleteOnServer(id: string) {
  try {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  } catch (e) {
    console.warn("[Store] 删除对话失败:", e);
  }
}

/* ── Store ─────────────────────────────────────────────── */

let initStarted = false; // 防 StrictMode 双调用

export const useChatStore = create<ChatState>((set, get) => ({
  // Initial state
  conversations: [],
  currentConversationId: null,
  loaded: false,
  settings: DEFAULT_SETTINGS,
  sidebarOpen: true,
  settingsOpen: false,
  imageGenOpen: false,
  isGenerating: false,

  // 启动:设置从 localStorage,对话从服务端;服务端为空时迁移旧数据
  _init: async () => {
    if (initStarted) return;
    initStarted = true;

    set({ settings: loadSettings() });

    try {
      let conversations: Conversation[] | null = null;
      try {
        const res = await fetch("/api/conversations");
        const data = await res.json();
        conversations = Array.isArray(data.conversations) ? data.conversations : [];
      } catch {
        conversations = null; // 服务端不可达,保留空态继续用
      }

      if (conversations !== null && conversations.length === 0) {
        const legacy = loadLegacyConversations();
        if (legacy.length > 0) {
          try {
            await fetch("/api/conversations/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ conversations: legacy }),
            });
            const res = await fetch("/api/conversations");
            const data = await res.json();
            conversations = Array.isArray(data.conversations) ? data.conversations : legacy;
          } catch {
            conversations = legacy; // 迁移失败就先用本地数据展示
          }
        }
      }

      set({
        conversations: conversations ?? [],
        currentConversationId: conversations?.[0]?.id ?? null,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },

  persistConversation: (id) => {
    const conv = get().conversations.find((c) => c.id === id);
    if (conv) void persistToServer(conv);
  },

  createConversation: () => {
    const id = uuidv4();
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: "新对话",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    set((state) => {
      const conversations = [conversation, ...state.conversations];
      return {
        conversations,
        currentConversationId: id,
      };
    });
    void persistToServer(conversation);

    return id;
  },

  deleteConversation: (id) => {
    set((state) => {
      const conversations = state.conversations.filter((c) => c.id !== id);
      return {
        conversations,
        currentConversationId:
          state.currentConversationId === id
            ? conversations[0]?.id ?? null
            : state.currentConversationId,
      };
    });
    void deleteOnServer(id);
  },

  setCurrentConversation: (id: string) => {
    set({ currentConversationId: id });
  },

  updateConversationTitle: (id: string, title: string) => {
    let updated: Conversation | undefined;
    set((state) => {
      const conversations = state.conversations.map((c) => {
        if (c.id !== id) return c;
        updated = { ...c, title, updatedAt: Date.now() };
        return updated;
      });
      return { conversations };
    });
    if (updated) void persistToServer(updated);
  },

  updateConversationSystemPrompt: (id: string, systemPrompt: string) => {
    let updated: Conversation | undefined;
    set((state) => {
      const conversations = state.conversations.map((c) => {
        if (c.id !== id) return c;
        updated = { ...c, systemPrompt: systemPrompt || undefined, updatedAt: Date.now() };
        return updated;
      });
      return { conversations };
    });
    if (updated) void persistToServer(updated);
  },

  addMessage: (conversationId, message) => {
    const fullMessage: ChatMessage = {
      ...message,
      id: uuidv4(),
      timestamp: Date.now(),
    };

    let updated: Conversation | undefined;
    set((state) => {
      const conversations = state.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const messages = [...c.messages, fullMessage];
        // Auto-title: use first user message's first 30 chars
        const title =
          c.messages.length === 0 && message.role === "user"
            ? message.content.slice(0, 30) + (message.content.length > 30 ? "..." : "")
            : c.title;
        updated = { ...c, messages, title, updatedAt: Date.now() };
        return updated;
      });
      return { conversations };
    });
    if (updated) void persistToServer(updated);
  },

  // 流式期间高频调用:只改内存,持久化由调用方在结束后 persistConversation
  updateLastAssistantMessage: (conversationId, content, extras) => {
    set((state) => {
      const conversations = state.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const messages = [...c.messages];
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "assistant") {
            const prev = messages[i];
            let toolEvents = prev.toolEvents;
            if (extras?.appendToolEvent) {
              toolEvents = [...(prev.toolEvents ?? []), extras.appendToolEvent];
            } else if (extras?.finishToolEvent) {
              // 给最近一个同名的 running 事件补上结果
              const evs = [...(prev.toolEvents ?? [])];
              for (let j = evs.length - 1; j >= 0; j--) {
                if (evs[j].label === extras.finishToolEvent.label && evs[j].status === "running") {
                  evs[j] = {
                    ...evs[j],
                    detail: extras.finishToolEvent.detail,
                    status: "done",
                  };
                  break;
                }
              }
              toolEvents = evs;
            }
            messages[i] = {
              ...prev,
              content: content !== undefined ? content : prev.content,
              toolEvents,
              toolNote: extras?.setToolNote ?? prev.toolNote,
            };
            break;
          }
        }
        return { ...c, messages };
      });
      return { conversations };
    });
  },

  // 编辑已发消息(配合 truncateMessagesAfter 实现重发分支)
  updateMessage: (conversationId, messageId, content) => {
    let updated: Conversation | undefined;
    set((state) => {
      const conversations = state.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const messages = c.messages.map((m) =>
          m.id === messageId ? { ...m, content } : m
        );
        updated = { ...c, messages, updatedAt: Date.now() };
        return updated;
      });
      return { conversations };
    });
    if (updated) void persistToServer(updated);
  },

  // 删除某条消息之后的所有消息(不含该条)
  truncateMessagesAfter: (conversationId, messageId) => {
    let updated: Conversation | undefined;
    set((state) => {
      const conversations = state.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const idx = c.messages.findIndex((m) => m.id === messageId);
        if (idx === -1) return c;
        updated = { ...c, messages: c.messages.slice(0, idx + 1), updatedAt: Date.now() };
        return updated;
      });
      return { conversations };
    });
    if (updated) void persistToServer(updated);
  },

  updateSettings: (newSettings) => {
    set((state) => {
      const settings = { ...state.settings, ...newSettings };
      saveSettings(settings);
      return { settings };
    });
  },

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setImageGenOpen: (open) => set({ imageGenOpen: open }),
  setIsGenerating: (generating) => set({ isGenerating: generating }),

  getCurrentConversation: () => {
    const state = get();
    return state.conversations.find((c) => c.id === state.currentConversationId);
  },

  getDisplayMessages: () => {
    const conversation = get().getCurrentConversation();
    if (!conversation) return [];
    const maxContext = get().settings.maxContextTurns;
    // Show the most recent N messages (sliding window for display)
    const allMessages = conversation.messages;
    if (allMessages.length <= maxContext * 2) return allMessages;
    return allMessages.slice(-(maxContext * 2));
  },
}));
