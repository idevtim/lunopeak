import { Card, Mono } from "@/components/ui/Page";
import { LiveDot } from "@/components/ui/LiveDot";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { providerAccent } from "@/views/tray-panel/shared";
import { cn } from "@/lib/utils";
import type { LiveEvent } from "@/types/api";
import { basename, describeAction, shortAge } from "./describe";

/** "What just happened": the merged event feed in plain words, newest first. */
export function LiveFeed({ events, className }: { events: LiveEvent[]; className?: string }) {
  const now = Date.now();
  return (
    <Card className={cn("flex flex-col gap-1 px-3 pb-2 pt-3.5", className)}>
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          What just happened
        </span>
        {events.length > 0 && (
          <span className="flex items-center gap-1.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">
            <LiveDot size="sm" />
            Live
          </span>
        )}
      </div>
      {events.length === 0 ? (
        <p className="m-0 px-1 pb-3 pt-1 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          Quiet for now. Steps show up here as your agents work.
        </p>
      ) : (
        <ol className="m-0 flex max-h-[calc(100vh-220px)] list-none flex-col overflow-y-auto p-0">
          {events.map((e, i) => (
            <FeedRow key={`${e.sessionId}-${e.ts}-${i}`} event={e} now={now} first={i === 0} />
          ))}
        </ol>
      )}
    </Card>
  );
}

function FeedRow({ event, now, first }: { event: LiveEvent; now: number; first: boolean }) {
  const { verb, detail } = describeAction(event.tool, event.summary);
  const folder = basename(event.cwd);
  return (
    <li
      className={cn(
        "flex gap-2.5 px-1 py-2",
        !first && "border-t border-black/[0.04] dark:border-white/[0.05]",
      )}
    >
      <ProviderIcon
        provider={event.agent}
        size={12}
        className={cn("mt-[3px] shrink-0", providerAccent(event.agent).text)}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span
          className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100"
          title={event.summary || undefined}
        >
          {verb}
          {detail && (
            <>
              {" "}
              <Mono className="text-zinc-700 dark:text-zinc-300">{detail}</Mono>
            </>
          )}
        </span>
        <span className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {folder && <>{folder} · </>}
          <Mono className="text-[11px]">{event.tool}</Mono>
        </span>
      </div>
      <span className="shrink-0 whitespace-nowrap text-[11.5px] text-zinc-400 dark:text-zinc-500">
        {shortAge(event.ts, now)}
      </span>
    </li>
  );
}
