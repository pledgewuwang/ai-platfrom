import { listConversations } from "@/lib/db";

export const dynamic = "force-dynamic";

/** 全量导出(备份用) */
export async function GET() {
  try {
    const conversations = listConversations();
    return Response.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Conversations Export API] error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
