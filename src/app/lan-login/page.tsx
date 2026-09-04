"use client"

export const dynamic = "force-dynamic";


import { Suspense, FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LockKeyhole, LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LanLoginPage() {
  return (
    <Suspense fallback={null}>
      <LanLoginForm />
    </Suspense>
  );
}

function LanLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/";
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/auth/lan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(data?.error || "登录失败");
        return;
      }
      router.replace(nextPath);
      router.refresh();
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <Card className="w-full max-w-md border-border bg-card/95 p-6 shadow-xl">
        <div className="mb-6 space-y-3">
          <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <ShieldCheck className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">局域网访问验证</h1>
            <p className="text-sm text-muted-foreground">
              检测到你正在通过局域网访问此应用，请输入访问密码继续。
            </p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="lan-password">访问密码</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="lan-password"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-9"
                placeholder="输入局域网访问密码"
              />
            </div>
          </div>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <Button className="w-full" type="submit" disabled={submitting || !password.trim()}>
            {submitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                正在验证
              </>
            ) : (
              "进入应用"
            )}
          </Button>
        </form>
      </Card>
    </main>
  );
}
