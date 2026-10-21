import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { formatBytes, plural } from "@/lib/format";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { Page, PageHeader, Card } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/stores/confirmStore";
import { toast } from "@/stores/toastStore";
import { cn } from "@/lib/utils";
import type { HygieneIssue, Severity } from "@/types/api";

const GROUPS: Array<{ severity: Severity; label: string; dot: string }> = [
  { severity: "error", label: "Fix soon", dot: "bg-rose-600" },
  { severity: "warn", label: "Worth cleaning up", dot: "bg-amber-500" },
  { severity: "info", label: "Good to know", dot: "bg-blue-500" },
];

// Tiebreaker order *within* a severity group — ranks relevance among equals.
const KIND_ORDER = [
  "env-not-gitignored", // secret leak
  "background-listener", // leftover process
  "missing-gitignore", // secret/artifact leak risk
  "uncommitted-changes", // unsaved work at risk
  "stale-branch",
  "disk-usage", // actionable space reclaim
  "stash",
  "missing-claude-md",
];

const severityRank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

const DIAGNOSE_PROMPT =
  "Look at my current hygiene issues and tell me which ones to fix first, with specific commands.";

/** One sentence + one action. Several issues of a kind collapse into one row. */
interface Row {
  key: string;
  kind: string;
  severity: Severity;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}

export function HygieneView() {
  const issues = useQuery(queries.hygiene);
  const { navigateTo } = useHashRoute();
  const showSkeleton = useDelayedLoading(issues.isLoading);
  const list = useMemo(() => issues.data ?? [], [issues.data]);
  const rows = useMemo(() => buildRows(list), [list]);

  if (issues.isLoading) return showSkeleton ? <HygieneSkeleton /> : null;

  const freeable = list
    .filter((i) => i.kind === "disk-usage")
    .reduce((sum, i) => sum + parseSize(i.message), 0);
  const repoCount = new Set(list.map((i) => i.repoPath).filter(Boolean)).size;

  return (
    <Page>
      <PageHeader
        title="Hygiene"
        lead={
          issues.isError ? undefined : list.length === 0 ? (
            "Nothing to clean up right now."
          ) : freeable > 0 ? (
            <>
              <b>{plural(list.length, "thing")}</b> worth cleaning up. Removing old build
              folders would free about <b>{formatBytes(freeable)}</b>.
            </>
          ) : (
            <>
              <b>{plural(list.length, "thing")}</b> worth cleaning up
              {repoCount > 0 && <> across {plural(repoCount, "repo")}</>}.
            </>
          )
        }
        actions={
          list.length > 0 && (
            <Button onClick={() => navigateTo("assistant", { q: DIAGNOSE_PROMPT })}>
              Ask what to fix first
            </Button>
          )
        }
      />

      {issues.isError ? (
        <ErrorState
          title="Couldn't check your repos"
          body="LunoPeak couldn't finish scanning your project folders. This is usually temporary."
          onRetry={() => void issues.refetch()}
          error={issues.error}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          healthy
          icon={CheckCircle2}
          title="All tidy"
          body="No leftover processes, stale branches or old stashes. Nice."
        />
      ) : (
        GROUPS.map((g) => {
          const groupRows = rows.filter((r) => r.severity === g.severity);
          if (groupRows.length === 0) return null;
          return (
            <section key={g.severity} className="flex flex-col gap-2">
              <div className="flex items-center gap-2 px-0.5">
                <span className={cn("size-[7px] shrink-0 rounded-full", g.dot)} />
                <h2 className="m-0 text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">
                  {g.label}
                </h2>
                <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                  {groupRows.length}
                </span>
              </div>
              <Card className="px-[18px] py-1">
                {groupRows.map((r, i) => (
                  <IssueRow key={r.key} row={r} first={i === 0} />
                ))}
              </Card>
            </section>
          );
        })
      )}
    </Page>
  );
}

function IssueRow({ row, first }: { row: Row; first: boolean }) {
  const muted = row.severity === "info" && !row.action;
  return (
    <div
      className={cn(
        "flex items-center gap-3 py-2.5",
        !first && "border-t border-black/[0.05] dark:border-white/[0.06]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "text-[13.5px] text-zinc-900 dark:text-zinc-100",
            !muted && "font-medium",
          )}
        >
          {row.title}
        </span>
        {row.detail && (
          <span
            className={cn(
              "truncate text-[12.5px]",
              muted ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-600 dark:text-zinc-400",
            )}
          >
            {row.detail}
          </span>
        )}
      </div>
      {row.action}
    </div>
  );
}

// ── Row building ───────────────────────────────────────────────────────

function buildRows(issues: HygieneIssue[]): Row[] {
  const byKind = new Map<string, HygieneIssue[]>();
  for (const issue of issues) {
    const arr = byKind.get(issue.kind) ?? [];
    arr.push(issue);
    byKind.set(issue.kind, arr);
  }

  const rows: Row[] = [];
  for (const [kind, items] of byKind) {
    const severity = items.reduce<Severity>(
      (worst, i) => (severityRank[i.severity] < severityRank[worst] ? i.severity : worst),
      items[0].severity,
    );
    const repos = repoList(items);
    switch (kind) {
      case "background-listener":
        // Each listener is its own process, so each gets its own Stop.
        // One pid can listen on several ports (or the same port over IPv4
        // and IPv6), so key by pid + message and drop exact repeats.
        for (const i of items) {
          const key = `listener-${i.target}-${i.message}`;
          if (rows.some((r) => r.key === key)) continue;
          const m = /^(.*) on :(\d+)$/.exec(i.message);
          rows.push({
            key,
            kind,
            severity,
            title: m ? `${m[1]} is still listening on port ${m[2]}` : i.message,
            detail: [i.repoName, i.details, i.target && `pid ${i.target}`]
              .filter(Boolean)
              .join(" · "),
            action: <StopAction issue={i} />,
          });
        }
        break;
      case "env-not-gitignored":
        for (const i of items) {
          rows.push({
            key: `env-${i.repoPath}`,
            kind,
            severity,
            title: `.env in ${i.repoName ?? "a repo"} isn't ignored by git`,
            detail: "Its secrets could end up in a commit",
            action: <GoAction route="env" label="Review" />,
          });
        }
        break;
      case "missing-gitignore":
        rows.push({
          key: kind,
          kind,
          severity,
          title: `${namesOrCount(items)} ${items.length === 1 ? "has" : "have"} no .gitignore`,
          detail: "Secrets and build output can end up in commits",
        });
        break;
      case "uncommitted-changes":
        rows.push({
          key: kind,
          kind,
          severity,
          title: `${plural(items.length, "repo")} ${items.length === 1 ? "has" : "have"} uncommitted changes`,
          detail: items
            .map((i) => `${i.repoName} (${i.message.replace(/ uncommitted/, "")})`)
            .join(", "),
          action: <GoAction route="repos" label="Open repos" />,
        });
        break;
      case "stale-branch":
        rows.push({
          key: kind,
          kind,
          severity,
          title: `${plural(items.length, "branch", "branches")} ${items.length === 1 ? "hasn't" : "haven't"} had a commit in 3 months`,
          detail: repos,
          action: <DeleteBranchesAction issues={items} />,
        });
        break;
      case "stash":
        rows.push({
          key: kind,
          kind,
          severity,
          title: `${plural(items.length, "stash", "stashes")} ${items.length === 1 ? "is" : "are"} sitting in your repos`,
          detail: repos,
          action: <DropStashesAction issues={items} />,
        });
        break;
      case "disk-usage": {
        const total = items.reduce((s, i) => s + parseSize(i.message), 0);
        const labels = items.map((i) => i.message.split(" — ")[0]);
        rows.push({
          key: kind,
          kind,
          severity,
          title: `${plural(items.length, "build or dependency folder")} ${items.length === 1 ? "takes" : "take"} up ${formatBytes(total)}`,
          detail: `${listWithMore(labels)} · rebuilt by your next install or build`,
          action: <CopyRemoveAction issues={items} />,
        });
        break;
      }
      case "missing-claude-md":
        rows.push({
          key: kind,
          kind,
          severity,
          title: `${namesOrCount(items)} ${items.length === 1 ? "has" : "have"} no CLAUDE.md`,
          detail: "Agents work better with project instructions",
        });
        break;
      default:
        for (const [n, i] of items.entries()) {
          rows.push({
            key: `${kind}-${n}`,
            kind,
            severity: i.severity,
            title: i.message,
            detail: i.repoName ?? i.details ?? undefined,
          });
        }
    }
  }

  return rows.sort((a, b) => {
    if (a.severity !== b.severity) return severityRank[a.severity] - severityRank[b.severity];
    const ai = KIND_ORDER.indexOf(a.kind);
    const bi = KIND_ORDER.indexOf(b.kind);
    return (ai === -1 ? KIND_ORDER.length : ai) - (bi === -1 ? KIND_ORDER.length : bi);
  });
}

/** "lunopeak-app (4), api-gateway (2)" — issue counts per repo. */
function repoList(items: HygieneIssue[]): string {
  const counts = new Map<string, number>();
  for (const i of items) {
    const name = i.repoName ?? "other";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name} (${n})` : name));
  return listWithMore(parts);
}

/** "design-tokens and infra-scripts" for two, "5 repos" beyond that. */
function namesOrCount(items: HygieneIssue[]): string {
  const names = items.map((i) => i.repoName ?? "A repo");
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return plural(names.length, "repo");
}

function listWithMore(parts: string[], max = 3): string {
  if (parts.length <= max) return parts.join(", ");
  return `${parts.slice(0, max).join(", ")} and ${parts.length - max} more`;
}

/** Disk-usage messages end in the backend's `human_bytes`: "— 1.2GB", "— 640MB". */
function parseSize(message: string): number {
  const m = /([\d.]+)\s*(GB|MB|KB|B)\s*$/.exec(message);
  if (!m) return 0;
  const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2] as "B" | "KB" | "MB" | "GB"];
  return Number(m[1]) * unit;
}

// ── Actions ────────────────────────────────────────────────────────────

function useRefreshHygiene() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: queries.hygiene.queryKey });
    void qc.invalidateQueries({ queryKey: queries.listeningPorts.queryKey });
  };
}

function GoAction({ route, label }: { route: "env" | "repos"; label: string }) {
  const { navigate } = useHashRoute();
  return <Button onClick={() => navigate(route)}>{label}</Button>;
}

function StopAction({ issue }: { issue: HygieneIssue }) {
  const refresh = useRefreshHygiene();
  const [busy, setBusy] = useState(false);
  const pid = Number(issue.target);
  if (!Number.isFinite(pid)) return null;
  return (
    <Button
      disabled={busy}
      onClick={async () => {
        const ok = await confirm({
          title: "Stop this process?",
          body: "It stops right away, and anything it hasn't saved is lost.",
          items: [`${issue.message} (pid ${pid})`],
          confirmLabel: "Stop it",
          destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        try {
          await api.killProcess(pid);
          toast.success("Stopped it", `${issue.message} (pid ${pid})`);
          refresh();
        } catch (e) {
          toast.error("Couldn't stop the process", errText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Stopping…" : "Stop it"}
    </Button>
  );
}

function DeleteBranchesAction({ issues }: { issues: HygieneIssue[] }) {
  const refresh = useRefreshHygiene();
  const [busy, setBusy] = useState(false);
  const targets = issues.filter((i) => i.target && i.repoPath);
  if (targets.length === 0) return null;
  const label = `Delete ${plural(targets.length, "branch", "branches")}`;
  return (
    <Button
      disabled={busy}
      onClick={async () => {
        const ok = await confirm({
          title: `${label}?`,
          body: "These local branches haven't had a commit in over 90 days. Only the local copies are deleted; anything pushed stays on the remote. Commits that were never merged or pushed are deleted with them.",
          items: targets.map((i) => `${i.repoName}: ${i.target}`),
          confirmLabel: label,
          destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        const failed = await runEach(targets, (i) =>
          api.gitDeleteBranch(i.repoPath as string, i.target as string),
        );
        setBusy(false);
        refresh();
        reportBatch(targets.length - failed.length, failed, "branch", "branches", "Deleted");
      }}
    >
      {busy ? "Deleting…" : "Delete branches"}
    </Button>
  );
}

function DropStashesAction({ issues }: { issues: HygieneIssue[] }) {
  const refresh = useRefreshHygiene();
  const [busy, setBusy] = useState(false);
  // Dropping stash@{0} renumbers the rest, so drop highest index first.
  const targets = issues
    .filter((i) => i.target && i.repoPath)
    .sort((a, b) => stashIndex(b.target) - stashIndex(a.target));
  if (targets.length === 0) return null;
  const label = `Drop ${plural(targets.length, "stash", "stashes")}`;
  return (
    <Button
      disabled={busy}
      onClick={async () => {
        const ok = await confirm({
          title: `${label}?`,
          body: "Stashed changes are deleted and can't be brought back.",
          items: targets.map((i) => `${i.repoName}: ${i.message}`),
          confirmLabel: label,
          destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        const failed = await runEach(targets, (i) =>
          api.gitDropStash(i.repoPath as string, i.target as string),
        );
        setBusy(false);
        refresh();
        reportBatch(targets.length - failed.length, failed, "stash", "stashes", "Dropped");
      }}
    >
      {busy ? "Dropping…" : "Drop stashes"}
    </Button>
  );
}

/** No delete-folder command exists, so hand over the `rm -rf` lines instead. */
function CopyRemoveAction({ issues }: { issues: HygieneIssue[] }) {
  const commands = issues.map((i) => i.command).filter((c): c is string => Boolean(c));
  if (commands.length === 0) return null;
  return (
    <Button
      onClick={() => {
        navigator.clipboard
          ?.writeText(commands.join("\n"))
          .then(() =>
            toast.success(
              "Copied the remove command",
              `Paste it in a terminal to delete ${plural(commands.length, "folder")}.`,
            ),
          )
          .catch((e) => toast.error("Couldn't copy", errText(e)));
      }}
    >
      Copy remove command
    </Button>
  );
}

function stashIndex(target: string | null | undefined): number {
  const m = /\{(\d+)\}/.exec(target ?? "");
  return m ? Number(m[1]) : 0;
}

/** Runs sequentially (git locks the repo) and returns the failures. */
async function runEach(
  items: HygieneIssue[],
  fn: (i: HygieneIssue) => Promise<unknown>,
): Promise<Array<{ issue: HygieneIssue; error: string }>> {
  const failed: Array<{ issue: HygieneIssue; error: string }> = [];
  for (const issue of items) {
    try {
      await fn(issue);
    } catch (e) {
      failed.push({ issue, error: errText(e) });
    }
  }
  return failed;
}

function reportBatch(
  done: number,
  failed: Array<{ issue: HygieneIssue; error: string }>,
  one: string,
  many: string,
  verb: string,
) {
  if (failed.length === 0) {
    toast.success(`${verb} ${plural(done, one, many)}`);
  } else {
    toast.error(
      `${verb} ${done} of ${done + failed.length}`,
      `${failed[0].issue.repoName}: ${failed[0].error}`,
    );
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function HygieneSkeleton() {
  return (
    <Page>
      <PageLoading caption="Looking for things worth cleaning up…">
        <Bone className="h-7 w-32 rounded-md" />
        <Bone className="h-4 w-96 rounded-md" />
        {[2, 3, 2].map((n, s) => (
          <div key={s} className="flex flex-col gap-2 pt-2">
            <Bone className="h-4 w-36 rounded-md" />
            <Bone className={n === 2 ? "h-28" : "h-40"} />
          </div>
        ))}
      </PageLoading>
    </Page>
  );
}
