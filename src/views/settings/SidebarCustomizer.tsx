import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Check, GripVertical, X } from "lucide-react";
import { sections, type RouteId, type RouteSection } from "@/routes";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { tokens } from "@/lib/tokens";

interface SidebarCustomizerProps {
  open: boolean;
  hidden: string[];
  /** RouteIds in the user's saved order. Empty means "default order". */
  order: string[];
  onClose: () => void;
  /** Save both hidden items + the new ordered RouteId list. */
  onSave: (nextHidden: string[], nextOrder: string[]) => void;
}

interface DropTarget {
  /** RouteId we're hovering over. */
  id: string;
  /** True if the dragged item should land before this row, false if after. */
  before: boolean;
}

/**
 * Build the in-customizer working order. Within each section we sort by the
 * user's saved order; routes absent from the saved list keep their default
 * position. The result is a flat list of RouteIds — manipulating it gives
 * us O(1) reordering with stable section grouping.
 */
function computeWorkingOrder(savedOrder: string[]): string[] {
  const idx = (id: string) => {
    const i = savedOrder.indexOf(id);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  return sections.flatMap((section) =>
    section.routes
      .slice()
      .sort((a, b) => idx(a.id) - idx(b.id))
      .map((r) => r.id),
  );
}

function buildSectionLookup(): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of sections) {
    for (const r of s.routes) m.set(r.id, s.id);
  }
  return m;
}

export function SidebarCustomizer({
  open,
  hidden,
  order,
  onClose,
  onSave,
}: SidebarCustomizerProps) {
  const [draftHidden, setDraftHidden] = useState<Set<string>>(
    () => new Set(hidden),
  );
  const [draftOrder, setDraftOrder] = useState<string[]>(() =>
    computeWorkingOrder(order),
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Drag preview position (cursor-relative, fixed-positioned overlay).
  const [previewPos, setPreviewPos] = useState<{ x: number; y: number } | null>(null);
  const [previewLabel, setPreviewLabel] = useState<string>("");

  // Latest drop target stashed in a ref so the pointerup handler reads the
  // up-to-date value without resubscribing the listener on every move.
  const dropTargetRef = useRef<DropTarget | null>(null);
  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);

  const sectionLookup = useMemo(buildSectionLookup, []);

  useEffect(() => {
    if (open) {
      setDraftHidden(new Set(hidden));
      setDraftOrder(computeWorkingOrder(order));
      setDragId(null);
      setDropTarget(null);
      setPreviewPos(null);
    }
  }, [open, hidden, order]);

  // Close on Escape for keyboard parity with native dialogs.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Pointer-event drag loop. We deliberately avoid the HTML5 drag-and-drop
  // API because Tauri's webview intercepts those events for native file
  // drops (which is why the cursor showed a "+" copy indicator instead of
  // running our handlers).
  useEffect(() => {
    if (!dragId) return;
    const sourceId = dragId;

    const onMove = (e: PointerEvent) => {
      // Prevent text selection / native drag behavior while reordering.
      e.preventDefault();
      setPreviewPos({ x: e.clientX, y: e.clientY });

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const li = el?.closest<HTMLLIElement>("li[data-route-id]");
      if (!li) {
        setDropTarget(null);
        return;
      }
      const targetId = li.dataset.routeId;
      if (!targetId || targetId === sourceId) {
        setDropTarget(null);
        return;
      }
      // Restrict drops to the same section so we don't break the section
      // grouping (each route is bound to a section in routes.ts).
      if (sectionLookup.get(targetId) !== sectionLookup.get(sourceId)) {
        setDropTarget(null);
        return;
      }
      const rect = li.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      setDropTarget((prev) =>
        prev?.id === targetId && prev.before === before
          ? prev
          : { id: targetId, before },
      );
    };

    const finish = () => {
      const target = dropTargetRef.current;
      if (target) {
        setDraftOrder((prev) => {
          const next = prev.slice();
          const fromIdx = next.indexOf(sourceId);
          if (fromIdx === -1) return prev;
          next.splice(fromIdx, 1);
          const targetIdx = next.indexOf(target.id);
          if (targetIdx === -1) return prev;
          const insertAt = target.before ? targetIdx : targetIdx + 1;
          next.splice(insertAt, 0, sourceId);
          return next;
        });
      }
      setDragId(null);
      setDropTarget(null);
      setPreviewPos(null);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);

    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
    };
  }, [dragId, sectionLookup]);

  const sectionedRoutes = useMemo<RouteSection[]>(() => {
    const idx = (id: string) => {
      const i = draftOrder.indexOf(id);
      return i === -1 ? Number.POSITIVE_INFINITY : i;
    };
    return sections.map((section) => ({
      ...section,
      routes: section.routes.slice().sort((a, b) => idx(a.id) - idx(b.id)),
    }));
  }, [draftOrder]);

  if (!open) return null;

  const toggle = (id: RouteId) => {
    setDraftHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onGripPointerDown = (
    e: ReactPointerEvent<HTMLSpanElement>,
    id: string,
    label: string,
  ) => {
    // Left button only — ignore right-click and middle-click.
    if (e.button !== 0) return;
    e.preventDefault();
    setDragId(id);
    setPreviewLabel(label);
    setPreviewPos({ x: e.clientX, y: e.clientY });
  };

  const apply = () => {
    onSave(Array.from(draftHidden), draftOrder);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Customize sidebar"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={cn(
          "max-h-[80vh] w-full max-w-md overflow-hidden rounded-2xl border shadow-2xl",
          tokens.border.default,
          "bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b border-black/[0.06] dark:border-white/[0.06] px-5 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Customize sidebar
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Drag the grip to reorder within a section. Click a page to show or hide it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-zinc-500 dark:text-zinc-400 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06] hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </header>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-5 py-4">
          {sectionedRoutes.map((section) => (
            <div key={section.id}>
              {section.label && (
                <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {section.label}
                </div>
              )}
              <ul className="space-y-0.5">
                {section.routes.map((route) => {
                  const isHidden = draftHidden.has(route.id);
                  const Icon = route.icon;
                  const isDragging = dragId === route.id;
                  const isOver = dropTarget?.id === route.id;
                  const showIndicatorBefore = isOver && dropTarget.before;
                  const showIndicatorAfter = isOver && !dropTarget.before;
                  return (
                    <li
                      key={route.id}
                      data-route-id={route.id}
                      className={cn(
                        "relative rounded-md transition-opacity",
                        isDragging && "opacity-30",
                      )}
                    >
                      {showIndicatorBefore && <DropIndicator position="top" />}
                      <div
                        className={cn(
                          "group flex items-center gap-1 rounded-md transition-colors",
                          "hover:bg-black/[0.04] dark:hover:bg-white/[0.04]",
                        )}
                      >
                        <span
                          role="button"
                          aria-label={`Drag ${route.label} to reorder`}
                          onPointerDown={(e) =>
                            onGripPointerDown(e, route.id, route.label)
                          }
                          className={cn(
                            "flex shrink-0 select-none items-center justify-center px-1 py-1.5",
                            "text-zinc-400 dark:text-zinc-400",
                            dragId
                              ? "cursor-grabbing"
                              : "cursor-grab hover:text-zinc-700 dark:hover:text-zinc-300",
                          )}
                          title="Drag to reorder"
                        >
                          <GripVertical size={13} strokeWidth={1.75} />
                        </span>
                        <button
                          type="button"
                          onClick={() => toggle(route.id)}
                          className={cn(
                            "flex flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm",
                            isHidden && "opacity-50",
                          )}
                        >
                          <Icon
                            size={14}
                            strokeWidth={1.75}
                            className="shrink-0 text-zinc-500 dark:text-zinc-400"
                          />
                          <span className="flex-1 text-zinc-800 dark:text-zinc-200">
                            {route.label}
                          </span>
                          <span
                            className={cn(
                              "flex size-4 items-center justify-center rounded border transition-colors",
                              isHidden
                                ? "border-black/[0.12] dark:border-white/[0.12] bg-transparent"
                                : "border-blue-500 bg-blue-500/20",
                            )}
                            aria-hidden
                          >
                            {!isHidden && (
                              <Check
                                size={10}
                                strokeWidth={3}
                                className="text-blue-700 dark:text-blue-300"
                              />
                            )}
                          </span>
                        </button>
                      </div>
                      {showIndicatorAfter && <DropIndicator position="bottom" />}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-black/[0.06] dark:border-white/[0.06] px-5 py-3">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {draftHidden.size} hidden of{" "}
            {sections.reduce((acc, s) => acc + s.routes.length, 0)}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={apply}>
              Apply
            </Button>
          </div>
        </footer>
      </div>

      {dragId && previewPos && (
        <DragPreview x={previewPos.x} y={previewPos.y} label={previewLabel} />
      )}
    </div>
  );
}

function DropIndicator({ position }: { position: "top" | "bottom" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-1 h-[2px] rounded-full bg-blue-500",
        position === "top" ? "-top-px" : "-bottom-px",
      )}
    />
  );
}

function DragPreview({
  x,
  y,
  label,
}: {
  x: number;
  y: number;
  label: string;
}) {
  return (
    <div
      aria-hidden
      style={{ left: x + 12, top: y + 12 }}
      className={cn(
        "pointer-events-none fixed z-[60] rounded-md border px-2.5 py-1 text-xs font-medium shadow-lg",
        "border-black/[0.08] dark:border-white/[0.08]",
        "bg-white/95 text-zinc-900 dark:bg-zinc-900/95 dark:text-zinc-100",
      )}
    >
      {label}
    </div>
  );
}
