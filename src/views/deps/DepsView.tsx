import { useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, CheckCircle2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { formatRelativeTime, plural } from "@/lib/format";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { Page, PageHeader, Card, CardHeader, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { confirm } from "@/stores/confirmStore";
import { toast } from "@/stores/toastStore";
import { cn } from "@/lib/utils";
import type { AuditManager, AuditReport, AuditTarget, DepEntry } from "@/types/api";

// Mirror of the backend's AUDIT_CACHE_TTL_MS — once a result is cached, neither
// the auto-run nor React Query re-fetches it until it's this stale.
const AUDIT_TTL_MS = 24 * 60 * 60 * 1000;

type Tab = "security" | "repos";

const auditKey = (t: AuditTarget) => ["audit", t.repoPath, t.manager] as const;

export function DepsView() {
  const [tab, setTab] = useState<Tab>("security");
  const qc = useQueryClient();
  const targetsQuery = useQuery(queries.auditTargets);
  const deps = useQuery(queries.deps);
  const targets = useMemo(() => targetsQuery.data ?? [], [targetsQuery.data]);

  // Each target's audit auto-runs on mount with force=false, so the backend
  // serves its 24h cache instead of re-running; results stream in as they land.
  const audits = useQueries({
    queries: targets.map((t) => ({
      queryKey: auditKey(t),
      queryFn: () => api.runAudit(t.repoPath, t.manager, false),
      staleTime: AUDIT_TTL_MS,
      gcTime: Infinity,
      retry: false,
    })),
  });

  const recheckAll = useMutation({
    mutationFn: () =>
      Promise.all(
        targets.map(async (t) => {
          const r = await api.runAudit(t.repoPath, t.manager, true);
          qc.setQueryData(auditKey(t), r);
        }),
      ),
    onSuccess: () => toast.success("Checked again", `Audited ${plural(targets.length, "project")}.`),
    onError: (e) => toast.error("Couldn't check again", e instanceof Error ? e.message : String(e)),
  });

  const loading = targetsQuery.isLoading || deps.isLoading;
  const showSkeleton = useDelayedLoading(loading);
  if (loading) return showSkeleton ? <DepsSkeleton /> : null;

  const rows = targets.map((t, i) => ({ target: t, query: audits[i] }));
  const pending = rows.filter((r) => r.query?.isLoading).length;
  const vulnerable = rows.filter((r) => (r.query?.data?.total ?? 0) > 0 && !r.query?.data?.error);
  const vulnCount = vulnerable.reduce((s, r) => s + (r.query?.data?.total ?? 0), 0);
  const depList = deps.data ?? [];
  const error = targetsQuery.error ?? deps.error;

  const lead =
    targets.length === 0 ? (
      depList.length > 0 ? (
        <>
          <b>{plural(new Set(depList.map((d) => d.repoPath)).size, "repo")}</b> with dependency
          manifests. None use a package manager LunoPeak can audit.
        </>
      ) : (
        "No dependency manifests found in your repos."
      )
    ) : vulnCount > 0 ? (
      <>
        <b className="!text-rose-700 dark:!text-rose-400">{plural(vulnCount, "security issue")}</b>{" "}
        in {plural(vulnerable.length, "project")}
        {pending > 0 && `, still checking ${pending} more`}.
      </>
    ) : pending > 0 ? (
      <>
        Checking <b>{plural(targets.length, "project")}</b> for known security issues…
      </>
    ) : (
      <>
        No known security issues in <b>{plural(targets.length, "project")}</b>.
      </>
    );

  return (
    <Page>
      <PageHeader
        title="Dependencies"
        lead={error ? undefined : lead}
        actions={
          targets.length > 0 && (
            <Button disabled={recheckAll.isPending || pending > 0} onClick={() => recheckAll.mutate()}>
              {recheckAll.isPending ? "Checking…" : "Check again"}
            </Button>
          )
        }
      />
      {error ? (
        <ErrorState
          title="Couldn't read your dependencies"
          body="LunoPeak couldn't finish scanning your repos for lockfiles and manifests."
          onRetry={() => {
            void targetsQuery.refetch();
            void deps.refetch();
          }}
          error={error}
        />
      ) : (
        <>
          <Segmented
            className="self-start"
            ariaLabel="View"
            value={tab}
            onChange={setTab}
            options={[
              { value: "security", label: "Security" },
              { value: "repos", label: "By repo" },
            ]}
          />
          {tab === "security" ? (
            <SecurityTab rows={rows} hasManifests={depList.length > 0} />
          ) : (
            <ReposTab list={depList} />
          )}
        </>
      )}
    </Page>
  );
}

interface AuditRow {
  target: AuditTarget;
  query: { data?: AuditReport; isLoading: boolean } | undefined;
}

function SecurityTab({ rows, hasManifests }: { rows: AuditRow[]; hasManifests: boolean }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Nothing to audit"
        body={
          hasManifests
            ? "Security checks cover npm, pnpm, yarn and Composer projects. None of your repos use them."
            : "When your repos have a package-lock, pnpm-lock, yarn.lock or composer.lock, LunoPeak checks them for known vulnerabilities."
        }
      />
    );
  }

  const settled = rows.filter((r) => r.query?.data && !r.query.isLoading);
  const flagged = settled.filter((r) => r.query!.data!.error || r.query!.data!.total > 0);
  const pending = rows.length - settled.length;

  if (pending === 0 && flagged.length === 0) {
    return (
      <EmptyState
        healthy
        icon={CheckCircle2}
        title="No known security issues"
        body={`Audits of ${plural(rows.length, "project")} found no known vulnerabilities. Results are cached for 24 hours.`}
      />
    );
  }

  // Worst first: high risk, then medium, then low, then couldn't-check.
  const sorted = [...flagged].sort((a, b) => riskRank(a.query!.data!) - riskRank(b.query!.data!));

  return (
    <Card>
      <CardHeader
        title="Security issues"
        meta={pending > 0 ? `Checking ${plural(pending, "project")}…` : "Fix these first"}
      />
      <div className="flex flex-col px-[18px] pb-1.5">
        {sorted.map((r, i) => (
          <SecurityRow key={`${r.target.repoPath}-${r.target.manager}`} target={r.target} report={r.query!.data!} first={i === 0} />
        ))}
        {sorted.length === 0 && (
          <span className="py-2.5 text-[12.5px] text-zinc-500 dark:text-zinc-400">
            Nothing found so far.
          </span>
        )}
      </div>
    </Card>
  );
}

function SecurityRow({
  target,
  report,
  first,
}: {
  target: AuditTarget;
  report: AuditReport;
  first: boolean;
}) {
  const qc = useQueryClient();
  // Only after a fix run do leftovers mean "couldn't be fixed automatically".
  const [lastWasFix, setLastWasFix] = useState(false);

  const recheck = useMutation({
    mutationFn: () => api.runAudit(target.repoPath, target.manager, true),
    onSuccess: (result) => {
      qc.setQueryData(auditKey(target), result);
      setLastWasFix(false);
    },
  });

  const fix = useMutation({
    mutationFn: () => api.runAuditFix(target.repoPath, target.manager),
    onSuccess: (result) => {
      qc.setQueryData(auditKey(target), result);
      setLastWasFix(true);
      if (result.error) {
        toast.error("Fix failed", result.error);
      } else if (result.total === 0) {
        toast.success(`Fixed ${target.repoName}`, "No known vulnerabilities left.");
      } else {
        toast.warning(
          `${plural(result.total, "issue")} left in ${target.repoName}`,
          "Some need a breaking upgrade and weren't fixed automatically.",
        );
      }
    },
    onError: (e) => toast.error("Fix failed", e instanceof Error ? e.message : String(e)),
  });

  const busy = recheck.isPending || fix.isPending;
  const residual = lastWasFix && !report.error && report.total > 0;
  const forceCmd = residual ? forceFixCommand(target.manager) : null;
  const risk = riskOf(report);

  let action;
  if (report.error) {
    action = (
      <Button disabled={busy} onClick={() => recheck.mutate()}>
        {recheck.isPending ? "Checking…" : "Check again"}
      </Button>
    );
  } else if (target.canFix && !residual) {
    action = (
      <Button
        disabled={busy}
        onClick={async () => {
          const ok = await confirm({
            title: `Fix ${target.repoName} automatically?`,
            body: `Runs ${fixCommand(target.manager)}, which downloads packages and can change package.json, the lock file and installed packages.`,
            items: [target.repoPath],
            confirmLabel: "Fix automatically",
          });
          if (ok) fix.mutate();
        }}
      >
        {fix.isPending ? "Fixing…" : "Fix automatically"}
      </Button>
    );
  } else {
    const cmd = forceCmd ?? `cd '${target.repoPath}' && ${auditCommand(target.manager)}`;
    action = <CopyButton text={cmd} />;
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3 py-2.5",
        !first && "border-t border-black/[0.05] dark:border-white/[0.06]",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <Mono className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            {target.repoName}
          </Mono>
          <Mono className="text-zinc-500 dark:text-zinc-400">{target.manager}</Mono>
          {report.error ? (
            <Pill tone="neutral">Couldn't check</Pill>
          ) : (
            <Pill tone={risk.tone}>{risk.label}</Pill>
          )}
        </span>
        <span className="text-[12.5px] text-zinc-700 dark:text-zinc-300">
          {report.error
            ? report.error
            : residual
              ? `${plural(report.total, "issue")} couldn't be fixed automatically — ${
                  forceCmd ? "they need a breaking upgrade." : "review the advisories and update by hand."
                }`
              : impactLine(report)}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {[
            report.message && !report.error ? report.message : null,
            !target.canFix && !report.error ? `${target.manager} has no safe automatic fix` : null,
            report.checkedAt != null ? `checked ${formatRelativeTime(report.checkedAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {action}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <Button
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => toast.success("Copied command", text))
          .catch((e) => toast.error("Couldn't copy", e instanceof Error ? e.message : String(e)));
      }}
    >
      Copy command
    </Button>
  );
}

function riskOf(r: AuditReport): { label: string; tone: "rose" | "amber" | "neutral" } {
  if (r.critical + r.high > 0) return { label: "High risk", tone: "rose" };
  if (r.moderate > 0) return { label: "Medium risk", tone: "amber" };
  return { label: "Low risk", tone: "neutral" };
}

function riskRank(r: AuditReport): number {
  if (r.error) return 3;
  if (r.critical + r.high > 0) return 0;
  return r.moderate > 0 ? 1 : 2;
}

/** "3 known vulnerabilities: 1 critical, 2 moderate". */
function impactLine(r: AuditReport): string {
  const parts = (
    [
      [r.critical, "critical"],
      [r.high, "high"],
      [r.moderate, "moderate"],
      [r.low, "low"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`);
  const head = `${plural(r.total, "known vulnerability", "known vulnerabilities")}`;
  return parts.length > 0 ? `${head}: ${parts.join(", ")}` : head;
}

/** Shows the advisories for managers without a safe automatic fix. */
function auditCommand(manager: AuditManager): string {
  return manager === "composer" ? "composer audit" : `${manager} audit`;
}

/** What the "Fix automatically" button runs, mirroring `audit.rs::run_audit_fix`. */
function fixCommand(manager: AuditManager): string {
  if (manager === "composer") return "composer update --with-dependencies";
  if (manager === "pnpm") return "pnpm audit --fix";
  return `${manager} audit fix`;
}

/**
 * Manual escalation when a safe fix leaves vulns that only a breaking
 * (semver-major) upgrade would resolve. Only npm has a clean `--force`.
 */
function forceFixCommand(manager: AuditManager): string | null {
  return manager === "npm" ? "npm audit fix --force" : null;
}

function ReposTab({ list }: { list: DepEntry[] }) {
  const sorted = useMemo(
    () => [...list].sort((a, b) => a.repoName.localeCompare(b.repoName)),
    [list],
  );
  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="No dependency manifests found"
        body="LunoPeak looks for package.json, Cargo.toml, pyproject.toml, go.mod and similar files in your repos."
      />
    );
  }
  const cols = "grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,1.6fr)]";
  return (
    <Card>
      <CardHeader title="Manifests" meta={plural(sorted.length, "manifest")} />
      <div
        className={cn(
          "grid gap-3 border-t border-black/[0.05] px-[18px] py-2 text-[11.5px] font-semibold text-zinc-500 dark:border-white/[0.06] dark:text-zinc-400",
          cols,
        )}
      >
        <span>Repo</span>
        <span>Manifest</span>
        <span>Packages</span>
        <span>Includes</span>
      </div>
      {sorted.map((d) => (
        <div
          key={`${d.repoPath}-${d.manifest}`}
          className={cn(
            "grid items-center gap-3 border-t border-black/[0.04] px-[18px] py-[9px] dark:border-white/[0.05]",
            cols,
          )}
        >
          <span className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100">{d.repoName}</span>
          <Mono className="truncate text-zinc-700 dark:text-zinc-300" title={`${d.manager} · ${d.manifest}`}>
            {d.manifest}
          </Mono>
          <span className="text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
            {d.prod.toLocaleString()}
            {d.dev > 0 && ` + ${d.dev.toLocaleString()} dev`}
          </span>
          <Mono className="truncate text-zinc-500 dark:text-zinc-400" title={d.examples.join(", ")}>
            {d.examples.join(", ") || "—"}
          </Mono>
        </div>
      ))}
    </Card>
  );
}

function DepsSkeleton() {
  return (
    <Page>
      <PageLoading caption="Checking your dependencies…">
        <Bone className="h-7 w-40 rounded-md" />
        <Bone className="h-4 w-80 rounded-md" />
        <Bone className="h-8 w-44 rounded-[9px]" />
        <Bone className="h-44" />
      </PageLoading>
    </Page>
  );
}
