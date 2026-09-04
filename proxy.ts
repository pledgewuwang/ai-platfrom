import { NextRequest, NextResponse } from "next/server";
import {
  extractClientIp,
  isLanAuthCookieValid,
  isLanAuthEnabled,
  isLanAuthRequired,
  LAN_AUTH_COOKIE,
} from "@/lib/lan-auth";

function isPublicPath(pathname: string): boolean {
  if (pathname === "/lan-login" || pathname.startsWith("/api/auth/lan")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname.startsWith("/icons/")) return true;
  if (
    pathname === "/favicon.ico" ||
    pathname === "/manifest.json" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js"
  ) {
    return true;
  }
  return /\.(?:png|svg|jpg|jpeg|gif|webp|ico)$/i.test(pathname);
}

export async function proxy(request: NextRequest) {
  if (!isLanAuthEnabled()) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const clientIp = extractClientIp(request.headers);
  if (!isLanAuthRequired(clientIp)) return NextResponse.next();

  const authed = await isLanAuthCookieValid(request.cookies.get(LAN_AUTH_COOKIE)?.value);
  if (authed) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "局域网访问需要先登录", code: "LAN_AUTH_REQUIRED" },
      { status: 401, headers: { "x-lan-auth-required": "1" } }
    );
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/lan-login";
  loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: "/:path*",
};
