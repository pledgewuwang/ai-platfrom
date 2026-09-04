/**
 * 写作台章节存储(服务端,JSON 文件落盘)
 * 复刻自 ai-novel-writer 的 novels.ts + json-store.ts:
 * - 原子写(tmp + rename,Windows 杀毒占用重试一次)
 * - 同文件写队列串行化,避免并发覆盖
 * - 章节 ID 白名单,杜绝路径穿越
 * 数据目录:<项目>/data/writing/
 */
import path from "path";
import { promises as fs } from "fs";
import { randomUUID } from "node:crypto";
import type { Chapter, ChapterMeta } from "./types";

const DATA_ROOT = path.join(process.cwd(), "data", "writing");
const CHAPTERS_DIR = path.join(DATA_ROOT, "chapters");
const NOVEL_FILE = path.join(DATA_ROOT, "novel.json");

/** 小说档案(单本,id 固定 default) */
type NovelFile = {
  id: string;
  title: string;
  chapterOrder: string[];
  createdAt: number;
  updatedAt: number;
};

/* ── JSON 原子读写(带写队列) ── */

const writeQueues = new Map<string, Promise<unknown>>();

/** 读 JSON;文件不存在或损坏返回 null(而非抛错);容忍 UTF-8 BOM */
async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

/** 原子写:先写 .tmp 再 rename,Windows 下遇杀毒占用(EPERM/EBUSY)重试一次 */
async function writeAtomic(file: string, data: unknown): Promise<void> {
  const tmp = file + "." + process.pid + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY") {
      await new Promise((r) => setTimeout(r, 50));
      await fs.rename(tmp, file);
    } else {
      try {
        await fs.unlink(tmp);
      } catch {
        /* 忽略清理失败 */
      }
      throw err;
    }
  }
}

/** 串行化写:同一文件的多次写入按顺序执行 */
function writeJson(file: string, data: unknown): Promise<void> {
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const next = prev
    .then(() => writeAtomic(file, data))
    .catch(() => undefined);
  writeQueues.set(file, next);
  return next;
}

/* ── 章节存取 ── */

/** 章节 ID 白名单:仅安全字符,杜绝路径穿越(../、编码斜杠等) */
const CHAPTER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isValidChapterId(id: string): boolean {
  return CHAPTER_ID_RE.test(id);
}

function chapterFile(id: string): string {
  return path.join(CHAPTERS_DIR, id + ".json");
}

function toMeta(ch: Chapter): ChapterMeta {
  return {
    id: ch.id,
    title: ch.title,
    order: ch.order,
    wordCount: ch.wordCount,
    createdAt: ch.createdAt,
    updatedAt: ch.updatedAt,
  };
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(CHAPTERS_DIR, { recursive: true });
}

async function readNovel(): Promise<NovelFile> {
  await ensureDirs();
  let novel = await readJson<NovelFile>(NOVEL_FILE);
  if (!novel) {
    novel = {
      id: "default",
      title: "我的小说",
      chapterOrder: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await writeJson(NOVEL_FILE, novel);
  }
  return novel;
}

async function writeNovel(novel: NovelFile): Promise<void> {
  novel.updatedAt = Date.now();
  await writeJson(NOVEL_FILE, novel);
}

function countWords(text: string): number {
  return [...text.replace(/\s/g, "")].length;
}

/** 章节列表(按 novel.json 中的顺序) */
export async function listChapters(full = false): Promise<ChapterMeta[] | Chapter[]> {
  const novel = await readNovel();
  const chapters: Chapter[] = [];
  for (let i = 0; i < novel.chapterOrder.length; i += 1) {
    const ch = await readJson<Chapter>(chapterFile(novel.chapterOrder[i]));
    if (ch) {
      ch.order = i;
      chapters.push(ch);
    }
  }
  if (full) return chapters;
  return chapters.map(toMeta);
}

export async function getChapter(id: string): Promise<Chapter | null> {
  if (!isValidChapterId(id)) return null;
  return readJson<Chapter>(chapterFile(id));
}

/** 新建章节(追加到末尾) */
export async function createChapter(title: string): Promise<Chapter> {
  const novel = await readNovel();
  const now = Date.now();
  const chapter: Chapter = {
    id: randomUUID().replace(/-/g, "").slice(0, 12),
    title,
    order: novel.chapterOrder.length,
    content: "",
    wordCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeJson(chapterFile(chapter.id), chapter);
  novel.chapterOrder.push(chapter.id);
  await writeNovel(novel);
  return chapter;
}

/** 保存章节(标题/正文部分更新) */
export async function saveChapter(
  id: string,
  patch: { title?: string; content?: string }
): Promise<Chapter | null> {
  if (!isValidChapterId(id)) return null;
  const ch = await readJson<Chapter>(chapterFile(id));
  if (!ch) return null;
  if (patch.title !== undefined) ch.title = patch.title;
  if (patch.content !== undefined) {
    ch.content = patch.content;
    ch.wordCount = countWords(patch.content);
  }
  ch.updatedAt = Date.now();
  await writeJson(chapterFile(id), ch);
  return ch;
}

/** 删除章节(连带从顺序表中移除) */
export async function deleteChapter(id: string): Promise<boolean> {
  if (!isValidChapterId(id)) return false;
  const novel = await readNovel();
  const idx = novel.chapterOrder.indexOf(id);
  if (idx === -1) return false;
  novel.chapterOrder.splice(idx, 1);
  await writeNovel(novel);
  try {
    await fs.unlink(chapterFile(id));
  } catch {
    /* 文件已不存在则忽略 */
  }
  return true;
}

/** 整体重排:ids 为完整的章节 ID 顺序 */
export async function reorderChapters(ids: string[]): Promise<ChapterMeta[]> {
  const novel = await readNovel();
  const valid = ids.filter((id) => novel.chapterOrder.includes(id));
  // 任何未出现在 ids 中的章节追加到末尾,防丢数据
  const missing = novel.chapterOrder.filter((id) => !valid.includes(id));
  novel.chapterOrder = [...valid, ...missing];
  await writeNovel(novel);
  return (await listChapters()) as ChapterMeta[];
}
