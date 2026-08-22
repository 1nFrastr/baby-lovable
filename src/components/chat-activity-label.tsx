"use client";

import { Shimmer } from "@/components/ai-elements/shimmer";

/** Matches ToolHeader row rhythm (py-0.5 + text-sm muted). */
export function ChatActivityLabel({ label }: { label: string }) {
  return (
    <p className="py-0.5 text-sm text-muted-foreground">
      <Shimmer as="span" className="text-sm" duration={1.5}>
        {label}
      </Shimmer>
    </p>
  );
}
