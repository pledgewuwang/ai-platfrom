import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import {
  buildLanAuthToken,
  getLanAuthPassword,
  isLanAuthEnabled,
  LAN_AUTH_COOKIE,
} from "@/lib/lan-auth";

const COOKIE_MAX_AGE = 60 * 60 * 12;

export async function POST(request: NextRequest) {
  if (!isLanAuthEnabled()) {
    return Response.json(
      { error: "未配置 LAN_AUTH_PASSWORD，局域网鉴权未启用" },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  const expected = getLanAuthPassword();
  if (!password || password !== expected) {
    return Response.json({ error: "密码不正确" }, { status: 401 });
  }

  const jar = await cookies();
  jar.set(LAN_AUTH_COOKIE, await buildLanAuthToken(expected), {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  return Response.json({ success: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.set(LAN_AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 0,
  });
  return Response.json({ success: true });
}
