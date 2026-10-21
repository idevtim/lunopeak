import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, X } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { EDITORS, filterEditorsForPlatform } from "@/lib/editors";
import { Button } from "@/components/ui/Button";
import { useEditorPickerStore } from "@/stores/editorPickerStore";
import { toast } from "@/stores/toastStore";
import { tokens } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Settings } from "@/types/api";

/**
 * Mounted once at the App root. Watches the editor-picker store for a
 * pending path, lets the user pick an editor, and (optionally) persists
 * the choice as the default.
 */
export function EditorPicker() {
  const path = useEditorPickerStore((s) => s.pendingPath);
  const close = useEditorPickerStore((s) => s.close);
  const settings = useQuery(queries.settings);
  const available = useQuery(queries.availableEditors);
  const editors = filterEditorsForPlatform(available.data);
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: api.updateSettings,
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: queries.settings.queryKey });
      const prev = qc.getQueryData<Settings>(queries.settings.queryKey);
      qc.setQueryData(queries.settings.queryKey, next);
      return { prev };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(queries.settings.queryKey, ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queries.settings.queryKey });
    },
  });

  const [selected, setSelected] = useState<string>("vscode");
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    if (path) {
      setSelected(settings.data?.editor?.defaultEditor ?? "vscode");
      setRemember(true);
    }
  }, [path, settings.data]);

  useEffect(() => {
    if (!path) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") confirm();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, selected, remember]);

  if (!path) return null;

  function confirm() {
    if (!path) return;
    api.openPathInEditor(path, selected).catch((e) => {
      const label = EDITORS.find((x) => x.id === selected)?.label ?? selected;
      toast.error(
        `Couldn't open in ${label}`,
        e instanceof Error ? e.message : String(e),
      );
    });
    if (remember && settings.data) {
      update.mutate({
        ...settings.data,
        editor: { ...settings.data.editor, defaultEditor: selected },
      });
    }
    close();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Open in editor"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={close}
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
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Open in…
            </h2>
            <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              {path}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-md p-1 text-zinc-500 dark:text-zinc-400 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.06] hover:text-zinc-800 dark:hover:text-zinc-200"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </header>

        <div className="max-h-[55vh] overflow-y-auto px-2 py-2">
          <ul className="space-y-0.5">
            {editors.map((ed) => {
              const active = selected === ed.id;
              return (
                <li key={ed.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(ed.id)}
                    onDoubleClick={() => {
                      setSelected(ed.id);
                      // Slight defer so state lands before confirm reads it.
                      setTimeout(confirm, 0);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                      active
                        ? "bg-blue-500/10 text-zinc-900 dark:text-zinc-100"
                        : "text-zinc-700 dark:text-zinc-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]",
                    )}
                  >
                    <ExternalLink
                      size={14}
                      strokeWidth={1.75}
                      className={cn(
                        "shrink-0",
                        active ? "text-blue-700 dark:text-blue-300" : "text-zinc-400 dark:text-zinc-400",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {ed.label}
                      </div>
                      <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                        {ed.hint}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                        active
                          ? "border-blue-500 bg-blue-500/20"
                          : "border-black/[0.12] dark:border-white/[0.12] bg-transparent",
                      )}
                      aria-hidden
                    >
                      {active && (
                        <Check size={10} strokeWidth={3} className="text-blue-700 dark:text-blue-300" />
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] dark:border-white/[0.06] px-5 py-3">
          <label className="flex items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="size-3.5 accent-blue-500"
            />
            Remember as default
          </label>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={confirm}>
              Open
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
