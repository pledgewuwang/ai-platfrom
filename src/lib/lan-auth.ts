const TAILSCALE_IPV6_PREFIX = "fd7a:115c:a1e0:";

export const LAN_AUTH_COOKIE = "ai_platform_lan_auth";

function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[|\]$/g, "");
}

function normalizeClientIp(raw: string): string {
  const first = raw.split(",")[0]?.trim() ?? "";
  if (!first) return "";
  if (first === "::1" || first === "localhost") return first;
  if (first.startsWith("[") && first.includes("]")) {
    return stripIpv6Brackets(first.slice(0, first.indexOf("]") + 1)).toLowerCase();
  }
  if (first.includes(":") && !first.includes(".")) {
    return stripIpv6Brackets(first).toLowerCase();
  }
  const ipv4WithPort = first.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  return (ipv4WithPort?.[1] ?? first).toLowerCase();
}

export function extractClientIp(headers: Headers): string | null {
  const raw =
    headers.get("x-forwarded-for") ||
    headers.get("x-real-ip") ||
    headers.get("cf-connecting-ip") ||
    "";
  const normalized = normalizeClientIp(raw);
  return normalized || null;
}

function parseIpv4(ip: string): [number, number, number, number] | null {
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const nums = match.slice(1).map(Number);
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

export function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || ip === "localhost" || ip.startsWith("127.");
}

export function isTailscaleIp(ip: string): boolean {
  if (ip.startsWith(TAILSCALE_IPV6_PREFIX)) return true;
  const parts = parseIpv4(ip);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

export function isPrivateLanIp(ip: string): boolean {
  if (isLoopbackIp(ip) || isTailscaleIp(ip)) return false;
  const parts = parseIpv4(ip);
  if (parts) {
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (ip.startsWith("fe80:")) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

export function isLanAuthRequired(ip: string | null): boolean {
  if (!ip) return false;
  return isPrivateLanIp(ip);
}

export function getLanAuthPassword(): string {
  return (process.env.LAN_AUTH_PASSWORD ?? "").trim();
}

export function isLanAuthEnabled(): boolean {
  return getLanAuthPassword().length > 0;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildLanAuthToken(password: string): Promise<string> {
  return `v1.${await sha256Hex(`ai-platform:lan-auth:${password}`)}`;
}

export async function isLanAuthCookieValid(cookieValue?: string | null): Promise<boolean> {
  if (!isLanAuthEnabled()) return true;
  if (!cookieValue) return false;
  return cookieValue === (await buildLanAuthToken(getLanAuthPassword()));
}
