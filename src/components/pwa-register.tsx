"use client";

import { useEffect } from "react";

/** 注册 Service Worker(PWA 可安装性) */
export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .catch((e) => console.warn("[PWA] SW 注册失败:", e));
    }
  }, []);

  return null;
}
