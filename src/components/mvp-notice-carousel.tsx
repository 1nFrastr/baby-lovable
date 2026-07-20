"use client";

import { useEffect, useState } from "react";

const NOTICE_MESSAGES = [
  "当前为 MVP 演示版，仍处于密集开发中，体验可能不稳定",
  "沙盒服务额度有限，用量很快可能触达上限，请适量体验",
  <>
    如需频繁测试，请联系作者{" "}
    <a
      href="mailto:zhoukai960@gmail.com"
      className="underline decoration-amber-500/60 underline-offset-2 hover:text-amber-800 dark:hover:text-amber-200"
    >
      zhoukai960@gmail.com
    </a>
  </>,
] as const;

const ROTATE_MS = 5500;

export function MvpNoticeCarousel({ className }: { className?: string }) {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let fadeTimeout: number | undefined;
    const id = window.setInterval(() => {
      setVisible(false);
      fadeTimeout = window.setTimeout(() => {
        setIndex((prev) => (prev + 1) % NOTICE_MESSAGES.length);
        setVisible(true);
      }, 220);
    }, ROTATE_MS);

    return () => {
      window.clearInterval(id);
      if (fadeTimeout !== undefined) {
        window.clearTimeout(fadeTimeout);
      }
    };
  }, []);

  return (
    <div
      className={`min-w-0 flex-1 px-4 ${className ?? ""}`}
      role="status"
      aria-live="polite"
    >
      <p
        className={`truncate text-center text-xs leading-relaxed text-amber-800/90 transition-opacity duration-200 dark:text-amber-200/80 ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        <span className="mr-1.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          MVP
        </span>
        {NOTICE_MESSAGES[index]}
      </p>
    </div>
  );
}
