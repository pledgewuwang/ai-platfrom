import { createChapter, listChapters, reorderChapters } from "@/lib/writing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 避免被 Next.js 误静态化,所有请求都走 runtime 内的随机 UUID/写磁盘
export const revalidate = 0;

/** GET /api/writing/chapters            → 章节元数据列表
 *  GET /api/writing/chapters?full=1     → 完整章节(含正文,导出用) */
export async function GET(request: Request) {
  const full = new URL(request.url).searchParams.get("full") === "1";
  const chapters = await listChapters(full);
  return Response.json({ chapters });
}

/** POST /api/writing/chapters {title?} → 新建章节 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { title?: string };
  const title = (body.title ?? "").trim().slice(0, 100) || "未命名章节";
  const chapter = await createChapter(title);
  return Response.json({ chapter }, { status: 201 });
}

/** PUT /api/writing/chapters {order: string[]} → 整体重排 */
export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { order?: string[] } | null;
  if (!body || !Array.isArray(body.order)) {
    return Response.json({ error: "order 数组必填" }, { status: 400 });
  }
  const chapters = await reorderChapters(body.order);
  return Response.json({ chapters });
}
