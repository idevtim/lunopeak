import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SwapGridItem {
  id: string;
  node: ReactNode;
}

interface SwapGridProps {
  editing: boolean;
  items: SwapGridItem[];
  /** localStorage key — must be unique per grid instance. */
  storageKey: string;
  /** Bump to discard the saved order and re-render in default order. */
  resetKey?: number;
  /** Class on the wrapper. Use any flex/grid layout you want. */
  className?: string;
  /**
   * When true, each card stretches vertically to match the tallest card
   * in its CSS grid row. Default false — cards keep their natural height.
   */
  stretch?: boolean;
}

interface DragState {
  id: string;
  startX: number;
  startY: number;
  pointerId: number;
}

/**
 * Pointer-event-based drag-to-swap layout. Items render at their natural
 * size in whatever layout `className` describes (flex column, CSS grid,
 * etc.). In edit mode the user grabs a card; on release while hovering a
 * different card, the two swap positions in the order array.
 *
 * Used for both the dashboard hero pair (single column) and the
 * operational grid (responsive 1/2/3 columns) — same UX in both spots.
 */
export function SwapGrid({
  editing,
  items,
  storageKey,
  resetKey = 0,
  className,
  stretch = false,
}: SwapGridProps) {
  const defaultOrder = items.map((i) => i.id);
  const [order, setOrder] = useState<string[]>(() =>
    loadOrder(storageKey, defaultOrder),
  );

  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (resetKey !== seenResetKey) {
    setSeenResetKey(resetKey);
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setOrder(defaultOrder);
  }

  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Window-level pointer listeners so a fast drag that exits the card's
  // bounds still keeps following the cursor and still drops correctly.
  useEffect(() => {
    if (!drag) return;

    const findUnderCursor = (clientX: number, clientY: number): string | null => {
      for (const [id, el] of itemRefs.current.entries()) {
        if (id === drag.id) continue;
        const r = el.getBoundingClientRect();
        if (
          clientX >= r.left &&
          clientX <= r.right &&
          clientY >= r.top &&
          clientY <= r.bottom
        ) {
          return id;
        }
      }
      return null;
    };

    const handleMove = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return;
      setOffset({ x: e.clientX - drag.startX, y: e.clientY - drag.startY });
      setHoverId(findUnderCursor(e.clientX, e.clientY));
    };
    const handleUp = (e: PointerEvent) => {
      if (e.pointerId !== drag.pointerId) return;
      const dropTarget = findUnderCursor(e.clientX, e.clientY);
      if (dropTarget) {
        setOrder((current) => {
          const a = current.indexOf(drag.id);
          const b = current.indexOf(dropTarget);
          if (a < 0 || b < 0) return current;
          const next = [...current];
          [next[a], next[b]] = [next[b], next[a]];
          saveOrder(storageKey, next);
          return next;
        });
      }
      setDrag(null);
      setOffset({ x: 0, y: 0 });
      setHoverId(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [drag, storageKey]);

  const ordered = order
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is SwapGridItem => Boolean(i));

  return (
    <div className={className}>
      {ordered.map((item) => {
        const isDragged = drag?.id === item.id;
        const isOver = hoverId === item.id;
        return (
          <div
            key={item.id}
            ref={(el) => {
              if (el) itemRefs.current.set(item.id, el);
              else itemRefs.current.delete(item.id);
            }}
            onPointerDown={(e) => {
              if (!editing) return;
              if (e.button !== 0) return;
              e.preventDefault();
              setDrag({
                id: item.id,
                startX: e.clientX,
                startY: e.clientY,
                pointerId: e.pointerId,
              });
            }}
            style={
              isDragged
                ? {
                    transform: `translate(${offset.x}px, ${offset.y}px)`,
                    zIndex: 5,
                  }
                : undefined
            }
            className={cn(
              "rounded-2xl",
              stretch && "h-full",
              editing &&
                "cursor-grab outline-1 outline-dashed outline-offset-[-2px] outline-blue-500/55",
              !isDragged && "transition-transform duration-200",
              isDragged &&
                "cursor-grabbing shadow-[0_12px_32px_rgb(0_0_0/0.18)] outline-blue-500/85 dark:shadow-[0_12px_32px_rgb(0_0_0/0.55)]",
              isOver && "outline-2 outline-blue-500/85",
            )}
          >
            <div
              className={cn(
                stretch && "h-full [&>*]:h-full",
                editing && "pointer-events-none select-none",
              )}
            >
              {item.node}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function loadOrder(key: string, fallback: string[]): string[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const known = parsed.filter(
      (id): id is string =>
        typeof id === "string" && fallback.includes(id),
    );
    const missing = fallback.filter((id) => !known.includes(id));
    return [...known, ...missing];
  } catch {
    return fallback;
  }
}

function saveOrder(key: string, order: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(order));
  } catch {
    // localStorage may be full or disabled
  }
}
