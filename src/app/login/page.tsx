"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const IS_DEV = process.env.NODE_ENV === "development";

type OAuthProvider = "github";

const PROVIDERS: Array<{ id: OAuthProvider; label: string }> = [
  { id: "github", label: "使用 GitHub 登录" },
];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/sessions";
  const error = searchParams.get("error");
  const errorReason = searchParams.get("reason");

  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleOAuth = async (provider: OAuthProvider) => {
    setStatus("loading");
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo },
      });

      if (signInError) {
        setStatus("error");
        setMessage(signInError.message);
      }
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "登录失败");
    }
  };

  const handleAnonymous = async () => {
    setStatus("loading");
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInAnonymously();

      if (signInError) {
        setStatus("error");
        setMessage(signInError.message);
        return;
      }

      router.push(next);
      router.refresh();
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "匿名登录失败");
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          登录 baby-lovable
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          使用第三方账号登录以管理你的项目会话
        </p>
      </div>

      {error === "auth_callback_failed" && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          认证回调失败，请重试。
          {errorReason ? (
            <span className="mt-1 block text-xs opacity-80">{errorReason}</span>
          ) : null}
        </p>
      )}

      {message && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {message}
        </p>
      )}

      <div className="space-y-3">
        {PROVIDERS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => void handleOAuth(id)}
            disabled={status === "loading"}
            className="w-full rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
          >
            {status === "loading" ? "跳转中…" : label}
          </button>
        ))}
      </div>

      {IS_DEV && (
        <>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-dashed border-zinc-200 dark:border-zinc-800" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-white px-2 text-zinc-400 dark:bg-zinc-950">
                开发环境
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleAnonymous()}
            disabled={status === "loading"}
            className="w-full rounded-xl border border-dashed border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900"
          >
            {status === "loading" ? "登录中…" : "匿名登录（测试）"}
          </button>
          <p className="text-center text-xs text-zinc-400">
            每次点击创建新测试账号，退出后可再试
          </p>
        </>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
