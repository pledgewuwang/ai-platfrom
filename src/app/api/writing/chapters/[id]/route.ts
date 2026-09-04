import { deleteChapter, getChapter, saveChapter } from "@/lib/writing/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** GET /api/writing/chapters/[id] → 完整章节 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const chapter = await getChapter(id);
  if (!chapter) return Response.json({ error: "章节不存在" }, { status: 404 });
  return Response.json({ chapter });
}

/** PUT /api/writing/chapters/[id] {title?, content?} → 保存 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as
    | { title?: string; content?: string }
    | null;
  if (!body || (body.title === undefined && body.content === undefined)) {
    return Response.json({ error: "title 或 content 至少一项" }, { status: 400 });
  }
  // 标题长度与正文体积钳制(防超大 JSON 撑爆磁盘)
  const patch: { title?: string; content?: string } = {};
  if (body.title !== undefined) patch.title = body.title.slice(0, 100);
  if (body.content !== undefined) patch.content = body.content.slice(0, 500000);
  const chapter = await saveChapter(id, patch);
  if (!chapter) return Response.json({ error: "章节不存在" }, { status: 404 });
  return Response.json({
    chapter: {
      id: chapter.id,
      title: chapter.title,
      order: chapter.order,
      wordCount: chapter.wordCount,
      createdAt: chapter.createdAt,
      updatedAt: chapter.updatedAt,
    },
  });
}

/** DELETE /api/writing/chapters/[id] */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteChapter(id);
  if (!ok) return Response.json({ error: "章节不存在" }, { status: 404 });
  return Response.json({ ok: true });
}
