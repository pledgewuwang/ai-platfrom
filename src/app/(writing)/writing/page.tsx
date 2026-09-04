"use client";

import dynamic from "next/dynamic";

/**
 * 写作台入口(独立路由组 (writing),URL /writing)。
 * 整个写作编辑器经 next/dynamic 懒加载且 ssr:false:
 * - 访问对话模式(/)完全不会加载写作台的任何代码,互不影响
 * - 访问 /writing 时才拉取编辑器 chunk(纯客户端渲染)
 */
const WritingWorkSpace = dynamic(() => import("@/components/writing/WorkSpace"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
      正在进入写作台…
    </div>
  ),
});

export default function WritingPage() {
  return <WritingWorkSpace />;
}
