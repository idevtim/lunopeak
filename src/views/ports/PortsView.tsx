import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { plural } from "@/lib/format";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { confirm } from "@/stores/confirmStore";
import { toast } from "@/stores/toastStore";
import { cn, openExternal } from "@/lib/utils";
import type { ActiveProcess, ListeningPort, RepoOverviewEntry } from "@/types/api";

/** One row: a port a process listens on (IPv4 + IPv6 binds collapse). */
interface PortRow {
  port: number;
  pid: number;
  process: string;
  cwd: string | null;
  repo: RepoOverviewEntry | null;
  label: string;
  /** Speaks HTTP, so Open in a browser makes sense. */
  web: boolean;
}

const AGENT_PROCESS = /claude|codex|cursor/i;

export function PortsView() {
  const ports = useQuery({ ...queries.listeningPorts, refetchInterval: 5000 });
  const overview = useQuery(queries.reposOverview);
  const agents = useQuery({ ...queries.activeProcesses, refetchInterval: 10_000 });

  const showSkeleton = useDelayedLoading(ports.isLoading);
  if (ports.isLoading) return showSkeleton ? <PortsSkeleton /> : null;

  const rows = buildRows(ports.data ?? [], overview.data?.repos ?? []);
  const projectRows = rows.filter((r) => r.repo);
  const systemRows = rows.filter((r) => !r.repo);
  const programs = new Set(rows.map((r) => r.pid)).size;
  const leftovers = agents.data ? findLeftovers(projectRows, agents.data) : [];

  return (
    <Page>
      <PageHeader
        title="Ports"
        lead={
          ports.isError ? undefined : rows.length === 0 ? (
            "Nothing is listening right now."
          ) : (
            <>
              <b>{plural(rows.length, "port")}</b> {rows.length === 1 ? "is" : "are"} open by{" "}
              {plural(programs, "program")}.{" "}
              {projectRows.length === 0
                ? "None belong to your projects."
                : `${projectRows.length} ${projectRows.length === 1 ? "belongs" : "belong"} to your projects.`}
            </>
          )
        }
      />

      {ports.isError ? (
        <ErrorState
          title="Couldn't list open ports"
          body="LunoPeak couldn't read which programs are listening. This is usually temporary."
          onRetry={() => void ports.refetch()}
          error={ports.error}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No ports open"
          body="Dev servers and databases show up here when they're running."
        />
      ) : (
        <>
          {projectRows.length > 0 && (
            <Section title="Your projects" rows={projectRows}>
              {leftovers.length > 0 && (
                <span className="px-0.5 pt-0.5 text-[12.5px] text-amber-700 dark:text-amber-400">
                  {leftoverNote(leftovers)}
                </span>
              )}
            </Section>
          )}
          {systemRows.length > 0 && <Section title="System" rows={systemRows} />}
        </>
      )}
    </Page>
  );
}

function Section({
  title,
  rows,
  children,
}: {
  title: string;
  rows: PortRow[];
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 px-0.5 text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">{title}</h2>
      <Card className="py-1">
        {rows.map((r, i) => (
          <Row key={`${r.pid}-${r.port}`} row={r} first={i === 0} />
        ))}
      </Card>
      {children}
    </section>
  );
}

function Row({ row, first }: { row: PortRow; first: boolean }) {
  const qc = useQueryClient();
  const stop = async () => {
    const ok = await confirm({
      title: `Stop ${row.label.toLowerCase()} on port ${row.port}?`,
      body: `This ends ${row.process} (pid ${row.pid}). Anything it was serving stops responding.`,
      confirmLabel: "Stop process",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.killProcess(row.pid);
      toast.success(`Stopped port ${row.port}`, `${row.process} · pid ${row.pid}`);
      void qc.invalidateQueries({ queryKey: queries.listeningPorts.queryKey });
      void qc.invalidateQueries({ queryKey: queries.hygiene.queryKey });
    } catch (e) {
      toast.error("Couldn't stop the process", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div
      className={cn(
        "grid grid-cols-[70px_minmax(0,1.4fr)_minmax(0,1fr)_150px] items-center gap-3 px-[18px] py-2.5",
        !first && "border-t border-black/[0.04] dark:border-white/[0.05]",
      )}
    >
      <span className="text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {row.port}
      </span>
      <div className="flex min-w-0 flex-col gap-px">
        <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">{row.label}</span>
        <Mono className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
          {row.process} · pid {row.pid}
        </Mono>
      </div>
      <Mono className="truncate text-zinc-600 dark:text-zinc-400" title={row.cwd ?? undefined}>
        {row.repo?.name ?? shortCwd(row.cwd)}
      </Mono>
      <span className="flex justify-end gap-1.5">
        {row.web && (
          <Button onClick={() => openExternal(`http://localhost:${row.port}`)}>Open</Button>
        )}
        <Button onClick={() => void stop()}>Stop</Button>
      </span>
    </div>
  );
}

function buildRows(list: ListeningPort[], repos: RepoOverviewEntry[]): PortRow[] {
  const seen = new Map<string, PortRow>();
  for (const p of list) {
    const key = `${p.pid}-${p.port}`;
    if (seen.has(key)) continue;
    const { label, web } = describe(p.process, p.port);
    seen.set(key, {
      port: p.port,
      pid: p.pid,
      process: p.process,
      cwd: p.cwd,
      repo: repoFor(p.cwd, repos),
      label,
      web,
    });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

/** The deepest repo containing `cwd` (handles nested repos). */
function repoFor(cwd: string | null, repos: RepoOverviewEntry[]): RepoOverviewEntry | null {
  if (!cwd) return null;
  let best: RepoOverviewEntry | null = null;
  for (const r of repos) {
    if ((cwd === r.path || cwd.startsWith(`${r.path}/`)) && (!best || r.path.length > best.path.length)) {
      best = r;
    }
  }
  return best;
}

/**
 * What a listener probably is, in plain words. Inferred from the process name
 * and the conventional port — a best guess, so the raw process stays visible
 * underneath.
 */
function describe(process: string, port: number): { label: string; web: boolean } {
  const n = process.toLowerCase();
  if (/postgres/.test(n)) return { label: "PostgreSQL", web: false };
  if (/mysql|mariadb/.test(n)) return { label: "MySQL", web: false };
  if (/redis/.test(n)) return { label: "Redis", web: false };
  if (/mongo/.test(n)) return { label: "MongoDB", web: false };
  if (/memcache/.test(n)) return { label: "Memcached", web: false };
  if (/ollama/.test(n)) return { label: "Ollama", web: true };
  if (/docker|com\.docke|vpnkit/.test(n)) return { label: "Docker container", web: true };
  if (/nginx|httpd|apache|caddy|traefik|envoy/.test(n)) return { label: "Web server", web: true };
  if (/workerd|wrangler/.test(n)) return { label: "Cloudflare Worker (wrangler)", web: true };
  if (/claude/.test(n)) return { label: "Claude Code", web: false };
  if (/codex/.test(n)) return { label: "Codex", web: false };
  if (/cursor/.test(n)) return { label: "Cursor", web: false };
  if (/code helper|electron/.test(n)) return { label: "Editor extension", web: false };
  if (/^(node|bun|deno)/.test(n)) {
    const byPort: Record<number, string> = {
      5173: "Vite dev server",
      5174: "Vite dev server",
      4173: "Vite preview server",
      1420: "Tauri dev server",
      3000: "Dev server",
      3001: "Dev server",
      6006: "Storybook",
      8787: "Cloudflare Worker (wrangler)",
      4321: "Astro dev server",
      9229: "Node debugger",
    };
    return { label: byPort[port] ?? "Node server", web: port !== 9229 };
  }
  if (/python/.test(n)) return { label: port === 8888 ? "Jupyter" : "Python server", web: true };
  if (/ruby|puma|rails/.test(n)) return { label: "Rails server", web: true };
  if (/php/.test(n)) return { label: "PHP server", web: true };
  if (/java/.test(n)) return { label: "Java server", web: true };
  if (/^go$|air$/.test(n)) return { label: "Go server", web: true };
  return { label: "Local server", web: port >= 1024 };
}

/**
 * Project servers whose repo has no running agent — likely started by a
 * session that's since closed. Agent processes themselves are excluded.
 */
function findLeftovers(rows: PortRow[], agents: ActiveProcess[]): PortRow[] {
  return rows.filter(
    (r) =>
      r.repo &&
      !AGENT_PROCESS.test(r.process) &&
      !agents.some(
        (a) => a.cwd && (a.cwd === r.repo!.path || a.cwd.startsWith(`${r.repo!.path}/`)),
      ),
  );
}

function leftoverNote(rows: PortRow[]): string {
  if (rows.length === 1) {
    const r = rows[0];
    return `Port ${r.port} is still running in ${r.repo!.name}, but no agent session is open there. It may be left over from a closed session.`;
  }
  const portsText = rows.map((r) => r.port);
  const last = portsText.pop();
  return `Ports ${portsText.join(", ")} and ${last} are running in projects with no open agent session. They may be left over from closed sessions.`;
}

function shortCwd(cwd: string | null): string {
  if (!cwd) return "—";
  return cwd.replace(/^\/(Users|home)\/[^/]+/, "~");
}

function PortsSkeleton() {
  return (
    <Page>
      <PageLoading caption="Checking which ports are in use…">
        <Bone className="h-7 w-24 rounded-md" />
        <Bone className="h-4 w-80 rounded-md" />
        <Bone className="mt-2 h-4 w-28 rounded-md" />
        <Bone className="h-48" />
        <Bone className="mt-2 h-4 w-20 rounded-md" />
        <Bone className="h-28" />
      </PageLoading>
    </Page>
  );
}
