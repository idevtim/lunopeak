import { useEffect, useRef, useState, type ReactNode } from "react";
import { WifiOff } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "./Sidebar";
import { WindowControls } from "./WindowControls";
import { usePlatform } from "@/hooks/usePlatform";
import { useWindowDrag } from "@/hooks/useWindowDrag";
import { useOnline } from "@/hooks/useOnline";
import { cn } from "@/lib/utils";
import type { RouteId } from "@/routes";

interface AppShellProps {
  current: RouteId;
  onNavigate: (id: RouteId) => void;
  children: ReactNode;
}

const TITLEBAR_HEIGHT = 36;

export function AppShell({ current, onNavigate, children }: AppShellProps) {
  const platform = usePlatform();
  const isMac = platform === "macos";
  const dragRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useWindowDrag(dragRef);
  const online = useOnline();

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [current]);

  return (
    <div className="relative flex h-full">
      <Sidebar current={current} onNavigate={onNavigate} topInset={TITLEBAR_HEIGHT} />
      <main
        ref={mainRef}
        className={cn(
          "relative min-w-0 flex-1 overflow-y-auto",
          // Solid backdrop on the content area so reading stays crisp;
          // the sidebar stays translucent so the OS material shows through.
          "bg-[#fafafa] dark:bg-[#17191f]/90",
        )}
        // Windows/Linux: clip the top so main's bg doesn't paint under the
        // drag-handle backdrop. Without this, two 85%-opaque layers stack and
        // the title bar reads visibly darker than the panel below it. macOS
        // uses native traffic lights over content (no clip needed).
        style={
          !isMac
            ? { clipPath: `inset(${TITLEBAR_HEIGHT}px 0 0 0)` }
            : undefined
        }
      >
        {!online && <OfflineBar />}
        {children}
      </main>

      {/* Drag handle across the top — lets users drag the window from the empty
          area next to the traffic lights / window controls. On Windows + Linux
          the strip over the main panel also acts as a title bar backdrop:
          scrolling content inside `main` would otherwise show through the
          (transparent) window-control area as it passes y=0–36. The sidebar
          gets its own drag handler in Sidebar.tsx so we can stop short of it
          and leave its translucent panel unobscured. */}
      <div
        ref={dragRef}
        aria-hidden
        className={cn(
          "pointer-events-auto absolute right-0 top-0 z-20",
          isMac
            ? "left-0"
            : "left-[232px] bg-zinc-50/85 dark:bg-[#17191f]/90",
        )}
        style={{ height: TITLEBAR_HEIGHT }}
      />

      {/* macOS renders native traffic lights via the overlay title bar style.
          Windows + Linux use decorations:false (for Mica / custom chrome) — render
          our own controls floating in the top-right corner. */}
      {!isMac && (
        <div
          className="absolute right-0 top-0 z-30"
          style={{ height: TITLEBAR_HEIGHT }}
        >
          <WindowControls platform={platform} />
        </div>
      )}
    </div>
  );
}

/**
 * Sticky amber bar while the machine is offline. Local data keeps working;
 * plan limits and the assistant need the network.
 */
function OfflineBar() {
  const qc = useQueryClient();
  // The moment we went offline — what the cached data reflects.
  const [since] = useState(() =>
    new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  );
  return (
    <div
      role="status"
      className="sticky top-0 z-[5] mt-9 flex items-center gap-2.5 border-b border-amber-500/30 bg-amber-50 py-[9px] pl-5 pr-8 text-[12.5px] text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <WifiOff size={14} strokeWidth={2} className="shrink-0 text-amber-600" />
      <span className="flex-1">
        <b className="font-semibold">You're offline.</b> Showing what LunoPeak saw at {since}. Plan
        limits and the assistant come back when you reconnect.
      </span>
      <button
        type="button"
        onClick={() => void qc.invalidateQueries()}
        className="rounded-[7px] border border-amber-700/30 bg-white px-2.5 py-[3px] text-xs font-medium text-amber-900 hover:bg-amber-50 dark:bg-transparent dark:text-amber-200"
      >
        Try again
      </button>
    </div>
  );
}
