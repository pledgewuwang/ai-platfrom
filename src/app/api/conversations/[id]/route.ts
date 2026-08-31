import {
  getConversation,
  upsertConversation,
  deleteConversation,
} from "@/lib/db";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** 获取单个对话 */
export async function GET(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const conversation = getConversation(id);
    if (!conversation) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ conversation });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Conversation API] get error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * 保存对话(整体 upsert)。
 * 前端在每轮交互结束后发送完整对话;未提供的字段保留库中原值。
 */
export async function PUT(request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid body" }, { status: 400 });
    }

    const existing = getConversation(id);
    const patch = body as Record<string, unknown>;

    const conversation = upsertConversation({
      id,
      title: patch.title ?? existing?.title,
      systemPrompt: patch.systemPrompt ?? existing?.systemPrompt,
      createdAt: patch.createdAt ?? existing?.createdAt,
      updatedAt: Date.now(),
      messages: Array.isArray(patch.messages) ? patch.messages : existing?.messages,
    });
    return Response.json({ conversation });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Conversation API] put error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** 删除对话 */
export async function DELETE(_request: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const ok = deleteConversation(id);
    if (!ok) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Conversation API] delete error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
