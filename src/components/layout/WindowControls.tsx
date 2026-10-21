import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import type { Platform } from "@/hooks/usePlatform";

interface WindowControlsProps {
  platform: Platform;
}

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const safeWindow = () => (isTauri() ? getCurrentWindow() : null);

/**
 * Custom min/max/close controls for Windows + Linux. macOS uses native
 * traffic lights via the overlay title bar style — render nothing.
 */
export function WindowControls({ platform }: WindowControlsProps) {
  if (platform === "macos") return null;

  const handleMinimize = () => safeWindow()?.minimize();
  const handleMaximize = () => safeWindow()?.toggleMaximize();
  const handleClose = () => safeWindow()?.close();

  // Windows convention: square, full-height, close hover red.
  // Linux: similar but smaller buttons; close not necessarily red.
  const buttonBase =
    "flex h-full items-center justify-center text-zinc-600 transition-colors dark:text-zinc-400";

  return (
    <div className={cn("flex h-full", platform === "windows" ? "w-[138px]" : "w-[108px]")}>
      <button
        aria-label="Minimize"
        onClick={handleMinimize}
        className={cn(
          buttonBase,
          "flex-1 hover:bg-black/[0.06] hover:text-zinc-900 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100",
        )}
      >
        <Minus className="size-3.5" strokeWidth={2} />
      </button>
      <button
        aria-label="Maximize"
        onClick={handleMaximize}
        className={cn(
          buttonBase,
          "flex-1 hover:bg-black/[0.06] hover:text-zinc-900 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100",
        )}
      >
        <Square className="size-3" strokeWidth={2} />
      </button>
      <button
        aria-label="Close"
        onClick={handleClose}
        className={cn(buttonBase, "flex-1 hover:bg-rose-500 hover:text-white")}
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
