import { NextResponse, type NextRequest } from "next/server";
import {
  extractClientIp,
  isLanAuthRequired,
  isLanAuthCookieValid,
  isLanAuthEnabled,
  LAN_AUTH_COOKIE,
} from "@/lib/lan-auth";

/**
 * LAN 鉴权中间件
 *
 * 由 server.js 保证 x-forwarded-for / x-real-ip 是真实 socket IP(客户端无法伪造)。
 * 规则:
 *  - 未配置 LAN_AUTH_PASSWORD → 放行
 *  - 非私网(公网 / Tailscale / localhost / 无法判定)→ 放行(Tailscale 不受影响)
 *  - 私网(RFC1918 / link-local / ULA 非 Tailscale)→ 校验 cookie,未登录 302 到 /lan-login
 */
export const config = {
  matcher: [
    // 排除:Next 静态、PWA 资源、登录页、登录 API、健康检查、图片历史目录
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|workbox-|generated/|api/auth/lan|api/health|lan-login).*)",
  ],
};

export async function middleware(request: NextRequest) {
  // 未配置密码 → 直接放行
  if (!isLanAuthEnabled()) return NextResponse.next();

  const ip = extractClientIp(request.headers);
  // 非私网(Tailscale / localhost / 公网 / 无法判定)→ 放行,不威胁 Tailscale 访问
  if (!isLanAuthRequired(ip)) return NextResponse.next();

  // 私网访问:校验登录 cookie
  const cookie = request.cookies.get(LAN_AUTH_COOKIE)?.value;
  if (await isLanAuthCookieValid(cookie)) return NextResponse.next();

  // 未登录 → 302 到登录页,带回跳地址
  const url = request.nextUrl.clone();
  const nextPath = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = "/lan-login";
  url.search = "";
  url.searchParams.set("next", nextPath);
  return NextResponse.redirect(url);
}
