import {
  listConversations,
  upsertConversation,
} from "@/lib/db";

export const dynamic = "force-dynamic";

/** 列出全部对话(含消息,个人应用规模直接全量返回) */
export async function GET() {
  try {
    return Response.json({ conversations: listConversations() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Conversations API] list error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** 新建对话 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const conversation = upsertConversation({
      title: typeof body?.title === "string" ? body.title : "新对话",
      systemPrompt: typeof body?.systemPrompt === "string" ? body.systemPrompt : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    });
    return Response.json({ conversation }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Conversations API] create error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
