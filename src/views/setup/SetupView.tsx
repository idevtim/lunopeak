import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useInstalledAgents } from "@/hooks/useInstalledAgents";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Page, PageHeader, Card, CardHeader, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { confirm } from "@/stores/confirmStore";
import { toast } from "@/stores/toastStore";
import {
  approvalPolicyLabel,
  cap,
  modelLabel,
  permissionModeLabel,
} from "@/views/_shared/agentLabels";
import type { McpServerEntry, PluginEntry, RepoSetup, SetupOverview } from "@/types/api";

type AgentName = "Claude" | "Codex" | "Cursor";

export function SetupView() {
  const overview = useQuery(queries.setupOverview);
  const installed = useInstalledAgents();
  const qc = useQueryClient();
  const openInEditor = useOpenInEditor();
  const showSkeleton = useDelayedLoading(overview.isLoading);
  const [adding, setAdding] = useState(false);

  const checkAgain = async () => {
    await Promise.all([
      overview.refetch(),
      qc.invalidateQueries({ queryKey: queries.installedAgents.queryKey }),
    ]);
    toast.info("Checked again");
  };

  if (overview.isLoading) return showSkeleton ? <SetupSkeleton /> : null;

  const header = (lead?: ReactNode) => (
    <PageHeader
      title="Setup checklist"
      lead={lead}
      actions={<Button onClick={() => void checkAgain()}>Check again</Button>}
    />
  );

  if (overview.isError || !overview.data) {
    return (
      <Page>
        {header()}
        <ErrorState
          title="Couldn't read your agent settings"
          body="LunoPeak couldn't read ~/.claude, ~/.codex or ~/.cursor. A settings file may have a syntax error."
          onRetry={() => void overview.refetch()}
          error={overview.error}
        />
      </Page>
    );
  }

  const data = overview.data;
  const hasClaude = installed?.claudeCode ?? true;
  if (installed && !installed.claudeCode && !installed.codex && !installed.cursor) {
    return (
      <Page>
        {header()}
        <EmptyState
          icon={Bot}
          title="No agents found on this Mac"
          body="Install Claude Code, Codex or Cursor, then come back. LunoPeak checks ~/.claude, ~/.codex and ~/.cursor."
          primary={{ label: "Check again", onClick: () => void checkAgain() }}
        />
      </Page>
    );
  }

  const missingClaudeMd = hasClaude ? data.repos.filter((r) => !r.hasClaudeMd) : [];

  const addClaudeMd = async () => {
    const n = missingClaudeMd.length;
    const ok = await confirm({
      title: n === 1 ? `Add a CLAUDE.md to ${missingClaudeMd[0].repoName}?` : `Add a CLAUDE.md to ${n} repos?`,
      body: "Each repo gets a starter file with Commands, Architecture and Conventions sections for you to fill in. Existing files are never overwritten.",
      items: missingClaudeMd.map((r) => r.repoName),
      confirmLabel: n === 1 ? "Add CLAUDE.md" : `Add ${n} CLAUDE.md files`,
    });
    if (!ok) return;
    setAdding(true);
    const results = await Promise.allSettled(
      missingClaudeMd.map((r) => api.createClaudeMd(r.repoPath)),
    );
    setAdding(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    const added = n - failed;
    if (added > 0) {
      const first = missingClaudeMd.find((_, i) => results[i].status === "fulfilled");
      toast.success(
        added === 1 ? `Added CLAUDE.md to ${first?.repoName}` : `Added ${added} CLAUDE.md files`,
        "Fill them in so agents know how each project works.",
        added === 1 && first
          ? { action: { label: "Open", onClick: () => openInEditor(`${first.repoPath}/CLAUDE.md`) } }
          : undefined,
      );
    }
    if (failed > 0) {
      const reason = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
      toast.error(
        `Couldn't add ${plural(failed, "CLAUDE.md file")}`,
        reason instanceof Error ? reason.message : String(reason),
      );
    }
    void qc.invalidateQueries({ queryKey: queries.setupOverview.queryKey });
    void qc.invalidateQueries({ queryKey: queries.claudeMd.queryKey });
    void qc.invalidateQueries({ queryKey: queries.hygiene.queryKey });
  };

  const problems = missingClaudeMd.length > 0 ? 1 : 0;

  return (
    <Page>
      {header(
        problems > 0 ? (
          <>
            How your agents are configured. <b>{plural(problems, "thing")}</b>{" "}
            {problems === 1 ? "needs" : "need"} fixing.
          </>
        ) : (
          "How your agents are configured. Nothing needs fixing."
        ),
      )}

      {missingClaudeMd.length > 0 && (
        <div className="rounded-[14px] border border-amber-500/30 bg-amber-500/[0.06] px-[18px] py-1.5">
          <FixRow
            dot="bg-amber-500"
            title={
              missingClaudeMd.length === 1
                ? `${missingClaudeMd[0].repoName} doesn't have a CLAUDE.md`
                : `${missingClaudeMd.length} repos don't have a CLAUDE.md`
            }
            detail={listNames(missingClaudeMd.map((r) => r.repoName))}
            action={
              <Button onClick={() => void addClaudeMd()} disabled={adding}>
                {adding ? "Adding…" : "Add CLAUDE.md"}
              </Button>
            }
          />
        </div>
      )}

      <AgentCards data={data} installed={installed} onOpen={openInEditor} />

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <McpCard servers={data.mcpServers} />
          {hasClaude && <PluginsCard plugins={data.plugins} />}
        </div>
        <RepoChecksCard repos={data.repos} servers={data.mcpServers} />
      </div>
    </Page>
  );
}

function listNames(names: string[], max = 4): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

function FixRow({
  dot,
  title,
  detail,
  action,
}: {
  dot: string;
  title: string;
  detail: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-black/[0.05] py-[9px] [&+&]:border-t dark:border-white/[0.06]">
      <span className={cn("size-[7px] shrink-0 rounded-full", dot)} />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
        <span className="truncate text-[12.5px] text-zinc-600 dark:text-zinc-400">{detail}</span>
      </div>
      {action}
    </div>
  );
}

// ── Agent cards ──────────────────────────────────────────────────────────

interface KV {
  label: string;
  value: ReactNode;
  /** Raw config key/value, shown small and mono under the plain value. */
  raw?: string;
}

function AgentCards({
  data,
  installed,
  onOpen,
}: {
  data: SetupOverview;
  installed: ReturnType<typeof useInstalledAgents>;
  onOpen: (path: string) => void;
}) {
  const { claude, codex, cursor, plugins, mcpServers } = data;
  const showClaude = Boolean(claude) || (installed?.claudeCode ?? false);
  const cursorTools = mcpServers.filter((s) => agentForScope(s.scope) === "Cursor").length;

  const cards: ReactNode[] = [];
  if (showClaude) {
    cards.push(
      <AgentCard
        key="claude"
        provider="claude"
        name="Claude Code"
        path={claude?.path ?? "~/.claude/settings.json"}
        rows={[
          { label: "Model", value: modelLabel(claude?.model) ?? "Default", raw: claude?.model ? `model: ${claude.model}` : undefined },
          {
            label: "Permissions",
            value: permissionModeLabel(claude?.permissionMode),
            raw: `defaultMode: ${claude?.permissionMode ?? "default"}`,
          },
          { label: "Plugins", value: plugins.length === 0 ? "None" : `${plugins.length} installed` },
        ]}
        onOpen={claude ? () => onOpen(claude.path) : undefined}
      />,
    );
  }
  if (codex) {
    cards.push(
      <AgentCard
        key="codex"
        provider="codex"
        name="Codex"
        path={codex.path}
        rows={[
          { label: "Model", value: modelLabel(codex.model) ?? "Default", raw: codex.model ?? undefined },
          {
            label: "Thinking effort",
            value: codex.reasoningEffort ? cap(codex.reasoningEffort) : "Default",
            raw: codex.reasoningEffort ? `model_reasoning_effort: ${codex.reasoningEffort}` : undefined,
          },
          {
            label: "Approval",
            value: approvalPolicyLabel(codex.approvalPolicy),
            raw: codex.approvalPolicy ? `approval_policy: ${codex.approvalPolicy}` : undefined,
          },
        ]}
        onOpen={() => onOpen(codex.path)}
      />,
    );
  }
  if (cursor) {
    cards.push(
      <AgentCard
        key="cursor"
        provider="cursor"
        name="Cursor"
        path={cursor.path}
        rows={[
          { label: "Projects", value: cursor.projectCount.toLocaleString() },
          { label: "Rules", value: plural(cursor.ruleCount, "rule file") },
          { label: "Connected tools", value: cursorTools.toLocaleString() },
        ]}
        openLabel="Open settings folder"
        onOpen={() => onOpen(cursor.path)}
      />,
    );
  }
  if (cards.length === 0) return null;
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-3">{cards}</div>;
}

const AGENT_TILE: Record<"claude" | "codex" | "cursor", string> = {
  claude: "bg-amber-600/[0.12] text-amber-600 dark:text-amber-400",
  codex: "bg-emerald-600/[0.12] text-emerald-600 dark:text-emerald-400",
  cursor: "bg-sky-600/[0.12] text-sky-600 dark:text-sky-400",
};

function AgentCard({
  provider,
  name,
  path,
  rows,
  openLabel = "Open settings file",
  onOpen,
}: {
  provider: "claude" | "codex" | "cursor";
  name: string;
  path: string;
  rows: KV[];
  openLabel?: string;
  onOpen?: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
      <div className="flex items-center gap-2.5">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", AGENT_TILE[provider])}>
          <ProviderIcon provider={provider} size={14} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{name}</span>
          <Mono className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400" title={path}>
            {tildify(path)}
          </Mono>
        </div>
      </div>
      <div className="flex flex-1 flex-col">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className={cn(
              "flex gap-2.5 py-[7px]",
              i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]",
            )}
          >
            <span className="flex-1 text-[12.5px] text-zinc-500 dark:text-zinc-400">{r.label}</span>
            <span className="flex min-w-0 flex-col items-end text-right">
              <span className="text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100">{r.value}</span>
              {r.raw && (
                <Mono className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">{r.raw}</Mono>
              )}
            </span>
          </div>
        ))}
      </div>
      {onOpen && (
        <Button variant="link" className="self-start" onClick={onOpen}>
          {openLabel}
        </Button>
      )}
    </Card>
  );
}

/** "/Users/me/.codex/config.toml" → "~/.codex/config.toml". */
function tildify(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

// ── Connected tools (MCP) ────────────────────────────────────────────────

function agentForScope(scope: string): AgentName {
  if (scope === "codex") return "Codex";
  if (scope === "cursor" || scope.startsWith("cursor:")) return "Cursor";
  return "Claude";
}

interface McpGroup {
  name: string;
  agents: AgentName[];
  /** Claude project names when the server is only set up in some projects. */
  projects: string[];
  global: boolean;
  command: string | null;
  argsSummary: string | null;
}

function groupMcp(servers: McpServerEntry[]): McpGroup[] {
  const byName = new Map<string, McpGroup>();
  for (const s of servers) {
    let g = byName.get(s.name);
    if (!g) {
      g = { name: s.name, agents: [], projects: [], global: false, command: s.command, argsSummary: s.argsSummary };
      byName.set(s.name, g);
    }
    const agent = agentForScope(s.scope);
    if (!g.agents.includes(agent)) g.agents.push(agent);
    if (agent === "Claude" && s.projectPath) g.projects.push(s.scope);
    else g.global = true;
  }
  const order: AgentName[] = ["Claude", "Codex", "Cursor"];
  for (const g of byName.values()) g.agents.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function McpCard({ servers }: { servers: McpServerEntry[] }) {
  const groups = useMemo(() => groupMcp(servers), [servers]);
  return (
    <Card className="pb-2">
      <CardHeader title="Connected tools (MCP)" meta="Services your agents can use" />
      {groups.length === 0 ? (
        <p className="m-0 px-[18px] pb-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          No MCP servers set up yet.
        </p>
      ) : (
        <div className="flex flex-col px-[18px]">
          {groups.map((g, i) => {
            const where =
              !g.global && g.projects.length > 0 ? ` in ${listNames(g.projects, 2)}` : "";
            const target = [g.command, g.argsSummary].filter(Boolean).join(" ");
            return (
              <div
                key={g.name}
                className={cn(
                  "flex items-center gap-3 py-[9px]",
                  i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-px">
                  <Mono className="text-[12.5px] text-zinc-900 dark:text-zinc-100">{g.name}</Mono>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    Used by {g.agents.join(", ")}
                    {where}
                  </span>
                </div>
                {target && (
                  <Mono
                    className="max-w-[45%] truncate text-[11.5px] text-zinc-400 dark:text-zinc-500"
                    title={target}
                  >
                    {target}
                  </Mono>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ── Plugins ──────────────────────────────────────────────────────────────

function PluginsCard({ plugins }: { plugins: PluginEntry[] }) {
  return (
    <Card className="pb-2">
      <CardHeader title="Plugins" meta="Add-ons installed in Claude Code" />
      {plugins.length === 0 ? (
        <p className="m-0 px-[18px] pb-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          No plugins installed.
        </p>
      ) : (
        <div className="flex flex-col px-[18px]">
          {plugins.map((p, i) => {
            const [short] = p.name.split("@");
            return (
              <div
                key={p.name}
                className={cn(
                  "flex items-center gap-3 py-2",
                  i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]",
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[13px] text-zinc-900 dark:text-zinc-100">{short}</span>
                  <Mono className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">
                    {[p.marketplace, p.version].filter(Boolean).join(" · ") || "—"}
                  </Mono>
                </div>
                {!p.enabled && <Pill>Turned off</Pill>}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ── Each repo ────────────────────────────────────────────────────────────

const REPO_COLS = "grid grid-cols-[minmax(0,1fr)_76px_76px_76px_44px] gap-x-2";

function RepoChecksCard({ repos, servers }: { repos: RepoSetup[]; servers: McpServerEntry[] }) {
  const sorted = useMemo(
    () => [...repos].sort((a, b) => a.repoName.localeCompare(b.repoName)),
    [repos],
  );
  // Claude's per-project MCP servers live in ~/.claude.json, not the repo.
  const claudeMcpPaths = useMemo(
    () => new Set(servers.map((s) => s.projectPath).filter((p): p is string => Boolean(p))),
    [servers],
  );
  return (
    <Card className="pb-2">
      <CardHeader title="Each repo" meta="Instructions agents read in each project" />
      {sorted.length === 0 ? (
        <p className="m-0 px-[18px] pb-2 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          No repos found yet. Add the folder where you keep your code in Settings.
        </p>
      ) : (
        <div className="px-[18px]">
          <div className={cn(REPO_COLS, "pb-1 text-[11.5px] font-semibold text-zinc-500 dark:text-zinc-400")}>
            <span>Repo</span>
            <span className="text-center">CLAUDE.md</span>
            <span className="text-center">AGENTS.md</span>
            <span className="text-center">Cursor rules</span>
            <span className="text-center">MCP</span>
          </div>
          {sorted.map((r, i) => (
            <div
              key={r.repoPath}
              className={cn(
                REPO_COLS,
                "items-center py-2",
                i > 0 && "border-t border-black/[0.05] dark:border-white/[0.06]",
              )}
            >
              <Mono className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100" title={r.repoPath}>
                {r.repoName}
              </Mono>
              <CheckCell ok={r.hasClaudeMd} label="CLAUDE.md" />
              <CheckCell ok={r.hasAgentsMd} label="AGENTS.md" />
              <CheckCell ok={r.hasCursorRules} label="Cursor rules" />
              <CheckCell ok={r.hasMcp || claudeMcpPaths.has(r.repoPath)} label="MCP" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CheckCell({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex justify-center" title={`${label}: ${ok ? "yes" : "no"}`}>
      {ok ? (
        <Check size={15} strokeWidth={2.5} className="text-emerald-600 dark:text-emerald-400" />
      ) : (
        <span className="h-0.5 w-3 rounded-sm bg-zinc-300 dark:bg-zinc-600" />
      )}
    </span>
  );
}

function SetupSkeleton() {
  return (
    <Page>
      <PageLoading caption="Checking how your agents are set up…">
        <Bone className="h-7 w-44 rounded-md" />
        <Bone className="h-4 w-96 rounded-md" />
        <Bone className="mt-2 h-16" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Bone key={i} className="h-44" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Bone className="h-56" />
          <Bone className="h-56" />
        </div>
      </PageLoading>
    </Page>
  );
}
