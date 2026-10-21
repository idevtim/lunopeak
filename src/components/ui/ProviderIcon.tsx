import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/// Brand mark for known agent providers. All marks render via CSS mask so
/// they inherit `currentColor` from the host element — keeps the visual
/// weight consistent across providers in the same row. Returns null for
/// unknown providers so callers can decide on a fallback.
export function ProviderIcon({
  provider,
  size = 14,
  className,
}: {
  provider: string;
  size?: number;
  className?: string;
}) {
  const key = provider.replace(/\.exe$/i, "").toLowerCase();
  const src =
    key === "claude" || key === "anthropic" ? "/icons/anthropic.png" :
    key === "codex" || key === "openai" ? "/icons/openai.png" :
    key === "gemini" ? "/icons/gemini.svg" :
    key === "xai" || key === "grok" ? "/icons/xai.svg" :
    key === "cursor" ? "/icons/cursor.png" :
    key === "ollama" ? "/icons/ollama.svg" :
    null;
  if (!src) return null;

  const style: CSSProperties = {
    width: size,
    height: size,
    WebkitMaskImage: `url("${src}")`,
    maskImage: `url("${src}")`,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
  };

  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 bg-current", className)}
      style={style}
    />
  );
}
