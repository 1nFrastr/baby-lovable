"use client";

import type { User } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";

interface AuthUserBarProps {
  className?: string;
}

function formatUserLabel(user: User): string {
  if (user.email) {
    return user.email;
  }
  if (user.is_anonymous) {
    return `匿名 ${user.id.slice(0, 8)}`;
  }
  return user.id.slice(0, 8);
}

export function AuthUserBar({ className }: AuthUserBarProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured());

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      return;
    }

    const supabase = createSupabaseBrowserClient();

    void supabase.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  if (!isSupabaseConfigured()) {
    return null;
  }

  if (loading) {
    return (
      <div className={className}>
        <span className="text-xs text-zinc-400">…</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={className}>
        <a
          href="/login"
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          登录
        </a>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 ${className ?? ""}`}>
      <span className="max-w-[200px] truncate text-sm text-zinc-500 dark:text-zinc-400">
        {formatUserLabel(user)}
      </span>
      <form action="/api/auth/signout" method="POST">
        <button
          type="submit"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          退出
        </button>
      </form>
    </div>
  );
}
