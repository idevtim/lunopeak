import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { Button } from "@/components/ui/Button";
import { tokens } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { Settings } from "@/types/api";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * First-run prompt asking whether LunoPeak should check for updates
 * automatically. Shown once — `general.updatePromptSeen` is flipped on
 * either response so we never re-prompt.
 */
export function UpdateAutoCheckPrompt() {
  const qc = useQueryClient();
  const settings = useQuery(queries.settings);
  const [autoInstall, setAutoInstall] = useState(false);

  const update = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queries.settings.queryKey });
    },
  });

  // Browser dev mode has no updater — don't prompt there.
  if (!isTauri()) return null;
  if (!settings.data) return null;
  if (settings.data.general.updatePromptSeen) return null;

  const persist = (next: Settings) => update.mutate(next);

  const dismiss = (checkUpdates: boolean) => {
    persist({
      ...settings.data!,
      general: {
        ...settings.data!.general,
        checkUpdates,
        autoInstallUpdates: checkUpdates && autoInstall,
        updatePromptSeen: true,
      },
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Check for updates automatically?"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div
        className={cn(
          "w-full max-w-md overflow-hidden rounded-2xl border shadow-2xl",
          tokens.border.default,
          tokens.bg.overlay,
          "backdrop-blur-md",
        )}
      >
        <div className="flex items-start gap-4 px-6 pt-6 pb-4">
          <img
            src="/app-icon.png"
            alt=""
            aria-hidden
            className="size-14 shrink-0 rounded-xl"
          />
          <div className="min-w-0 flex-1">
            <h2 className={cn("text-base font-semibold", tokens.text.primary)}>
              Check for updates automatically?
            </h2>
            <p className={cn("mt-1.5 text-sm leading-relaxed", tokens.text.tertiary)}>
              Should LunoPeak automatically check for updates? You can always
              check for updates manually from Settings.
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <CheckBox
                checked={autoInstall}
                onChange={() => setAutoInstall((v) => !v)}
              />
              Automatically download and install updates
            </label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] bg-black/[0.02] px-5 py-3 dark:border-white/[0.06] dark:bg-black/20">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => dismiss(false)}
            disabled={update.isPending}
          >
            Don't Check
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => dismiss(true)}
            disabled={update.isPending}
          >
            Check Automatically
          </Button>
        </div>
      </div>
    </div>
  );
}

function CheckBox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onChange}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
        checked
          ? "border-blue-500 bg-blue-500"
          : "border-black/[0.18] bg-black/[0.04] hover:border-black/[0.28] dark:border-white/[0.18] dark:bg-white/[0.04] dark:hover:border-white/[0.28]",
      )}
    >
      {checked && <Check className="size-3 text-white" strokeWidth={3} />}
    </button>
  );
}
