import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PWA support via next-pwa is not compatible with Next.js 15+ app router.
  // Using basic service worker registration instead.
  // To add full PWA, consider using next-pwa or @ducanh2912/next-pwa.

  // Allow cross-origin dev access via Tailscale
  allowedDevOrigins: ["100.86.102.69", "infinity.tailcbe28f.ts.net", "node.tailcbe28f.ts.net"],

  // Allow images from external providers
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "api.bfl.ml",
      },
      {
        protocol: "https",
        hostname: "openai.com",
      },
      {
        protocol: "https",
        hostname: "dashscope.aliyuncs.com",
      },
      {
        protocol: "https",
        hostname: "**.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "oaidalleapiprodscus.blob.core.windows.net",
      },
    ],
  },

  // Headers: SSE streaming + 基础安全头（2026-08-30 加固）
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/api/chat",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Connection", value: "keep-alive" },
          { key: "X-Accel-Buffering", value: "no" },
        ],
      },
    ];
  },
};

export default nextConfig;
