import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleDot } from "lucide-react";
import { queries } from "@/lib/queries";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import type { HookEntry } from "@/types/api";

/** Order triggers roughly by when they fire in a session. */
const EVENT_ORDER = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Notification",
  "SubagentStop",
  "PreCompact",
  "Stop",
  "SessionEnd",
];

interface Group {
  key: string;
  event: string;
  matcher: string | null;
  hooks: HookEntry[];
}

export function HooksView() {
  const hooks = useQuery(queries.hooks);
  const openInEditor = useOpenInEditor();
  const showSkeleton = useDelayedLoading(hooks.isLoading);
  const list = useMemo(() => hooks.data ?? [], [hooks.data]);
  const groups = useMemo(() => groupHooks(list), [list]);

  if (hooks.isLoading) return showSkeleton ? <HooksSkeleton /> : null;

  // Only known when at least one global hook exists — that's the file it came from.
  const globalSettings = list.find((h) => h.scope === "global" && h.sourcePath)?.sourcePath ?? null;
  const header = (
    <PageHeader
      title="Hooks"
      lead={
        list.length > 0 ? (
          <>
            <b>{plural(list.length, "hook")}</b> {list.length === 1 ? "runs" : "run"} automatically
            when agents do certain things.
          </>
        ) : undefined
      }
      actions={
        globalSettings && (
          <Button onClick={() => openInEditor(globalSettings)}>Open settings.json</Button>
        )
      }
    />
  );

  if (hooks.isError) {
    return (
      <Page>
        {header}
        <ErrorState
          title="Couldn't read your hooks"
          body="LunoPeak couldn't read the hooks in ~/.claude/settings.json or your repos' .claude/settings.json. One of them may have a syntax error."
          onRetry={() => void hooks.refetch()}
          error={hooks.error}
        />
      </Page>
    );
  }

  if (list.length === 0) {
    return (
      <Page>
        {header}
        <EmptyState
          icon={CircleDot}
          title="No hooks set up"
          body="Hooks run a command when an agent does something, like formatting a file after it's edited. Add them under “hooks” in ~/.claude/settings.json."
        />
      </Page>
    );
  }

  return (
    <Page>
      {header}
      <div className="flex flex-col gap-3">
        {groups.map((g) => (
          <Card key={g.key} className="flex flex-col gap-1.5 px-[18px] pb-2 pt-3.5">
            <div className="flex items-baseline gap-2.5">
              <h3 className="m-0 flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {triggerLabel(g.event, g.matcher)}
              </h3>
              <Mono className="text-[11.5px] text-zinc-500 dark:text-zinc-400">
                {g.matcher ? `${g.event} · ${matcherList(g.matcher).join(", ")}` : g.event}
              </Mono>
            </div>
            <div className="flex flex-col">
              {g.hooks.map((h, i) => (
                <div
                  key={`${h.sourcePath ?? h.scope}-${i}`}
                  className={cn(
                    "flex items-center gap-3 py-[9px]",
                    i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]",
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[13px] text-zinc-900 dark:text-zinc-100">
                      {describeCommand(h.command)}
                    </span>
                    <Mono
                      className="truncate text-xs text-zinc-600 dark:text-zinc-400"
                      title={h.command}
                    >
                      {h.command}
                    </Mono>
                  </div>
                  {h.scope === "global" ? (
                    <Pill>All projects</Pill>
                  ) : (
                    <Pill tone="blue" title={h.repoPath ?? undefined}>
                      {h.repoName ?? "This repo"}
                    </Pill>
                  )}
                  {h.sourcePath && (
                    <Button
                      variant="link"
                      className="text-xs"
                      onClick={() => openInEditor(h.sourcePath!)}
                      title={`Open ${h.sourcePath}`}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}

function groupHooks(list: HookEntry[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const h of list) {
    const matcher = h.matcher?.trim() || null;
    const key = `${h.event}|${matcher ?? ""}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, event: h.event, matcher, hooks: [] };
      byKey.set(key, g);
    }
    g.hooks.push(h);
  }
  const rank = (e: string) => {
    const i = EVENT_ORDER.indexOf(e);
    return i === -1 ? EVENT_ORDER.length : i;
  };
  return [...byKey.values()].sort(
    (a, b) =>
      rank(a.event) - rank(b.event) ||
      a.event.localeCompare(b.event) ||
      (a.matcher ?? "").localeCompare(b.matcher ?? ""),
  );
}

function matcherList(matcher: string): string[] {
  return matcher.split("|").map((m) => m.trim()).filter(Boolean);
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** What the matcher targets, as the subject of "Before … runs" / "After …". */
function toolPhrase(matcher: string | null): { before: string; after: string } {
  const tools = matcher ? matcherList(matcher) : [];
  if (tools.length === 0 || tools.includes("*")) {
    return { before: "Before any tool runs", after: "After any tool runs" };
  }
  if (tools.every((t) => t === "Bash")) {
    return { before: "Before a command runs", after: "After a command runs" };
  }
  if (tools.every((t) => EDIT_TOOLS.has(t))) {
    return { before: "Before a file is edited", after: "After a file is edited" };
  }
  if (tools.every((t) => t === "Read")) {
    return { before: "Before a file is read", after: "After a file is read" };
  }
  if (tools.every((t) => t.startsWith("mcp__"))) {
    return { before: "Before a connected tool runs", after: "After a connected tool runs" };
  }
  if (tools.every((t) => t === "Task" || t === "Agent")) {
    return { before: "Before a subagent starts", after: "After a subagent finishes" };
  }
  return { before: "Before certain tools run", after: "After certain tools run" };
}

/** Plain trigger for a hook event; the raw event stays visible in mono beside it. */
function triggerLabel(event: string, matcher: string | null): string {
  switch (event) {
    case "PreToolUse":
      return toolPhrase(matcher).before;
    case "PostToolUse":
      return toolPhrase(matcher).after;
    case "UserPromptSubmit":
      return "When you send a message";
    case "SessionStart":
      return "When a session starts";
    case "SessionEnd":
      return "When a session ends";
    case "Stop":
      return "When Claude finishes responding";
    case "SubagentStop":
      return "When a subagent finishes";
    case "Notification":
      return "When Claude sends a notification";
    case "PreCompact":
      return "Before the conversation is compacted";
    case "PermissionRequest":
      return "When Claude asks for permission";
    default:
      return event;
  }
}

const RUNNERS = new Set([
  "npx", "pnpm", "pnpx", "yarn", "npm", "bunx", "bun", "uv", "uvx", "python", "python3",
  "node", "bash", "sh", "zsh", "run", "exec", "dlx",
]);

/**
 * Hooks carry no description, so name the program the command runs:
 * "pnpm prettier --write $FILE" → "Runs prettier".
 */
function describeCommand(command: string): string {
  const words = command.trim().split(/\s+/);
  for (const w of words) {
    if (/^[A-Z_][A-Z0-9_]*=/.test(w) || w.startsWith("-")) continue;
    const name = w.replace(/^["']|["']$/g, "").split("/").pop() ?? w;
    if (!name || RUNNERS.has(name)) continue;
    return `Runs ${name}`;
  }
  return "Runs a command";
}

function HooksSkeleton() {
  return (
    <Page>
      <PageLoading caption="Reading your hooks…">
        <Bone className="h-7 w-24 rounded-md" />
        <Bone className="h-4 w-80 rounded-md" />
        {[1, 2, 1].map((n, i) => (
          <Bone key={i} className={n === 2 ? "mt-2 h-32" : "mt-2 h-24"} />
        ))}
      </PageLoading>
    </Page>
  );
}
