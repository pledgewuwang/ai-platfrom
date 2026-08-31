import { upsertConversation } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * 导入备份(同时用于首次 localStorage → 服务端迁移)。
 * 按 id upsert,重复导入幂等。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const list = (body as { conversations?: unknown } | null)?.conversations;
    if (!Array.isArray(list)) {
      return Response.json({ error: "conversations array is required" }, { status: 400 });
    }
    if (list.length > 5000) {
      return Response.json({ error: "too many conversations" }, { status: 400 });
    }

    let imported = 0;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      upsertConversation(item as Record<string, unknown>);
      imported++;
    }
    return Response.json({ imported });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Conversations Import API] error:", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
