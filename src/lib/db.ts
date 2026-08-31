/**
 * 对话持久化(SQLite,零依赖 node:sqlite)
 * 服务端是唯一数据源:浏览器 localStorage 只做首次迁移,之后不再使用。
 * 个人应用规模,一条对话一行、messages 整体存 JSON,简单可靠。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { randomUUID } from "node:crypto";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "chat.db");

// dev 热重载会重建模块,用 globalThis 保证全局只有一份连接
const g = globalThis as unknown as { __chatDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (g.__chatDb) return g.__chatDb;
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '新对话',
      system_prompt TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      messages TEXT NOT NULL DEFAULT '[]'
    )
  `);
  g.__chatDb = db;
  return db;
}

/* ── 类型 ──────────────────────────────────────────────── */

export interface ToolEvent {
  label: string;
  detail?: string;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  imageUrls?: string[];
  toolEvents?: ToolEvent[];
  /** 本轮工具调用摘要,随历史发回给模型(工具记忆) */
  toolNote?: string;
}

export interface StoredConversation {
  id: string;
  title: string;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

/* ── 清洗(导入/写入统一走这里,坏数据不落库) ──────────── */

const ROLES = new Set(["user", "assistant", "system"]);

export function sanitizeMessages(input: unknown): StoredMessage[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      id: typeof m.id === "string" && m.id ? m.id : randomUUID(),
      role: (ROLES.has(m.role as string) ? m.role : "user") as StoredMessage["role"],
      content: typeof m.content === "string" ? m.content.slice(0, 500_000) : "",
      timestamp: Number(m.timestamp) || Date.now(),
      imageUrls: Array.isArray(m.imageUrls)
        ? m.imageUrls.filter((u): u is string => typeof u === "string").slice(0, 20)
        : undefined,
      toolEvents: Array.isArray(m.toolEvents)
        ? m.toolEvents
            .filter(
              (e): e is ToolEvent =>
                !!e && typeof e === "object" && typeof (e as ToolEvent).label === "string"
            )
            .slice(0, 20)
            .map((e) => ({
              label: String(e.label).slice(0, 100),
              detail: typeof e.detail === "string" ? e.detail.slice(0, 300) : undefined,
            }))
        : undefined,
      toolNote:
        typeof m.toolNote === "string" ? m.toolNote.slice(0, 5000) : undefined,
    }));
}

function sanitizeConversation(input: Record<string, unknown>): StoredConversation {
  const now = Date.now();
  return {
    id: typeof input.id === "string" && input.id ? input.id : randomUUID(),
    title:
      typeof input.title === "string" && input.title.trim()
        ? input.title.slice(0, 200)
        : "新对话",
    systemPrompt:
      typeof input.systemPrompt === "string" ? input.systemPrompt.slice(0, 20_000) : undefined,
    createdAt: Number(input.createdAt) || now,
    updatedAt: Number(input.updatedAt) || now,
    messages: sanitizeMessages(input.messages),
  };
}

/* ── CRUD ──────────────────────────────────────────────── */

interface ConvRow {
  id: string;
  title: string;
  system_prompt: string;
  created_at: number;
  updated_at: number;
  messages: string;
}

function rowToConversation(row: ConvRow): StoredConversation {
  let messages: StoredMessage[] = [];
  try {
    messages = sanitizeMessages(JSON.parse(row.messages || "[]"));
  } catch {
    // 损坏的 JSON 按空处理
  }
  return {
    id: row.id,
    title: row.title,
    systemPrompt: row.system_prompt || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
  };
}

export function listConversations(): StoredConversation[] {
  const rows = getDb()
    .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
    .all() as unknown as ConvRow[];
  return rows.map(rowToConversation);
}

export function getConversation(id: string): StoredConversation | null {
  const row = getDb()
    .prepare("SELECT * FROM conversations WHERE id = ?")
    .get(id) as ConvRow | undefined;
  return row ? rowToConversation(row) : null;
}

export function upsertConversation(input: Record<string, unknown>): StoredConversation {
  const c = sanitizeConversation(input);
  getDb()
    .prepare(
      `INSERT INTO conversations (id, title, system_prompt, created_at, updated_at, messages)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         system_prompt = excluded.system_prompt,
         updated_at = excluded.updated_at,
         messages = excluded.messages`
    )
    .run(c.id, c.title, c.systemPrompt ?? "", c.createdAt, c.updatedAt, JSON.stringify(c.messages));
  return c;
}

export function deleteConversation(id: string): boolean {
  const result = getDb().prepare("DELETE FROM conversations WHERE id = ?").run(id);
  return result.changes > 0;
}
