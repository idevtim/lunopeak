import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill, type PillTone } from "@/components/ui/Pill";
import { getAppVersion } from "@/lib/diagnostics";
import { RELEASES_URL, installAndRestart, parseReleaseNotes, type ReleaseTag } from "@/lib/updates";
import { openExternal } from "@/lib/utils";
import { useUpdateStore } from "@/stores/updateStore";

const tagTone: Record<ReleaseTag, PillTone> = { New: "green", Better: "blue", Fixed: "neutral" };

/**
 * What's new in the pending update, fed from the GitHub release body. With
 * no pending update it describes the installed version from its release page.
 */
export function WhatsNewDialog() {
  const { update, whatsNewOpen, setWhatsNewOpen, phase } = useUpdateStore();
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    if (whatsNewOpen) void getAppVersion().then(setCurrent);
  }, [whatsNewOpen]);

  useEffect(() => {
    if (!whatsNewOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setWhatsNewOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [whatsNewOpen, setWhatsNewOpen]);

  if (!whatsNewOpen) return null;
  const close = () => setWhatsNewOpen(false);
  const version = update?.version ?? current ?? "";
  const items = parseReleaseNotes(update?.body);
  const released = update?.date
    ? new Date(update.date.replace(" ", "T").replace(/ .*$/, "")).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
      })
    : null;
  const notesUrl = update ? `${RELEASES_URL}/tag/v${update.version}` : RELEASES_URL;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/25 animate-lp-fade-in"
      onClick={close}
    >
      <div
        role="dialog"
        aria-label={`What's new in LunoPeak ${version}`}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[620px] w-[520px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_30px_80px_rgba(0,0,0,0.3),0_0_0_0.5px_rgba(0,0,0,0.2)] animate-lp-pop-in dark:bg-zinc-900"
      >
        <div className="flex items-start gap-3.5 px-[22px] pb-4 pt-[22px]">
          <img src="/app-icon.png" alt="" className="size-11 rounded-[10px]" />
          <div className="flex flex-1 flex-col gap-[3px]">
            <span className="text-lg font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
              What's new in LunoPeak {version}
            </span>
            <span className="text-[12.5px] text-zinc-500 dark:text-zinc-400">
              {[released && `Released ${released}`, update && current && `you have ${current}`]
                .filter(Boolean)
                .join(" · ") || "Release notes"}
            </span>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="flex size-7 items-center justify-center rounded-[7px] text-zinc-500 hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <X size={14} strokeWidth={2.25} />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-[22px] pb-[18px] pt-1">
          {items.length === 0 ? (
            <span className="text-[13px] text-zinc-600 dark:text-zinc-400">
              The full notes for this release are on GitHub.
            </span>
          ) : (
            items.map((it) => (
              <div key={it.title} className="flex items-start gap-3">
                <Pill tone={tagTone[it.tag]} className="mt-0.5 w-16 justify-center text-[11px]">
                  {it.tag}
                </Pill>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
                    {it.title}
                  </span>
                  {it.body && (
                    <span className="text-[12.5px] leading-normal text-zinc-600 text-pretty dark:text-zinc-400">
                      {it.body}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-black/[0.06] bg-zinc-50 py-3 pl-[22px] pr-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <button
            type="button"
            onClick={() => openExternal(notesUrl)}
            className="flex-1 text-left text-[12.5px] font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            Full release notes ↗
          </button>
          <Button size="md" onClick={close}>
            {update ? "Later" : "Close"}
          </Button>
          {update && (
            <Button
              size="md"
              variant="primary"
              disabled={phase === "installing"}
              onClick={() => void installAndRestart()}
            >
              {phase === "installing" ? "Installing…" : "Restart to update"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
