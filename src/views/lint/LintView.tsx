import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, FileText } from "lucide-react";
import { queries } from "@/lib/queries";
import { formatBytes, plural } from "@/lib/format";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useInstalledAgents } from "@/hooks/useInstalledAgents";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useOpenInEditor } from "@/hooks/useOpenInEditor";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { ClaudeOnlyEmpty } from "@/views/_shared/ClaudeOnlyEmpty";
import { toast } from "@/stores/toastStore";
import type { ClaudeMdLintReport, LintIssue } from "@/types/api";

// Mirrors MAX_LINES / MAX_BYTES in src-tauri/src/scanners/health.rs.
const MAX_LINES = 200;
const MAX_BYTES = 10_000;

/** A lint issue rephrased for people, with the line it points at when known. */
interface Finding {
  line: number | null;
  error: boolean;
  message: string;
  rule: string;
}

export function LintView() {
  const reports = useQuery(queries.claudeMdLintReports);
  const installed = useInstalledAgents();
  const { navigateTo } = useHashRoute();
  const showSkeleton = useDelayedLoading(reports.isLoading);
  if (reports.isLoading) return showSkeleton ? <LintSkeleton /> : null;

  const list = reports.data ?? [];
  const flagged = list.filter((r) => r.issues.length > 0);
  const findings = flagged.map((r) => ({ report: r, findings: describe(r) }));
  const all = findings.flatMap((f) => f.findings);
  const errors = all.filter((f) => f.error).length;
  const warnings = all.length - errors;
  const clean = list.length - flagged.length;

  const askClaude = () => navigateTo("assistant", { q: buildAssistantPrompt(flagged) });
  const copyPrompt = () => {
    navigator.clipboard
      ?.writeText(buildLlmPrompt(flagged))
      .then(() =>
        toast.success("Copied as a prompt", "Paste it into Claude Code or any chat to get fixes."),
      )
      .catch((e) => toast.error("Couldn't copy", e instanceof Error ? e.message : String(e)));
  };

  let body;
  if (reports.isError) {
    body = (
      <ErrorState
        title="Couldn't read your CLAUDE.md files"
        body="LunoPeak couldn't finish scanning your repos. This is usually temporary."
        onRetry={() => void reports.refetch()}
        error={reports.error}
      />
    );
  } else if (list.length === 0) {
    body =
      installed && !installed.claudeCode ? (
        <ClaudeOnlyEmpty
          feature="lint"
          description="This view lints CLAUDE.md project-instruction files for stale references, oversize sections, and the like. Install Claude Code to use it."
        />
      ) : (
        <EmptyState
          icon={FileText}
          title="No CLAUDE.md files yet"
          body="Lint checks each repo's CLAUDE.md for paths that no longer exist and files that are too long for Claude to read."
          primary={{ label: "Open Memory", onClick: () => navigateTo("memory") }}
        />
      );
  } else if (flagged.length === 0) {
    body = (
      <EmptyState
        healthy
        icon={CheckCircle2}
        title="No lint issues"
        body={`All ${plural(list.length, "CLAUDE.md file")} passed their lint checks.`}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {findings.map(({ report, findings }) => (
          <FileCard key={report.path} report={report} findings={findings} />
        ))}
      </div>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Lint"
        lead={
          reports.isError || list.length === 0 ? (
            "Checks each repo's CLAUDE.md for problems that confuse agents."
          ) : flagged.length === 0 ? (
            <>
              All <b>{plural(list.length, "CLAUDE.md file")}</b> look good.
            </>
          ) : (
            <>
              <b>{plural(all.length, "issue")}</b> in {plural(flagged.length, "CLAUDE.md file")}
              {errors > 0 && warnings > 0
                ? `: ${plural(errors, "error")} and ${plural(warnings, "warning")}`
                : ""}
              .{clean > 0 && ` ${clean} ${clean === 1 ? "file is" : "files are"} clean.`}
            </>
          )
        }
        actions={
          flagged.length > 0 && (
            <>
              <Button onClick={copyPrompt}>Copy as prompt</Button>
              <Button variant="primary" onClick={askClaude}>
                Ask Claude to fix
              </Button>
            </>
          )
        }
      />
      {body}
    </Page>
  );
}

function FileCard({ report, findings }: { report: ClaudeMdLintReport; findings: Finding[] }) {
  const openInEditor = useOpenInEditor();
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-black/[0.05] bg-[#fcfcfc] px-[18px] py-[11px] dark:border-white/[0.06] dark:bg-white/[0.02]">
        <Mono className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-900 dark:text-zinc-100" title={report.path}>
          CLAUDE.md
          <span className="ml-2 text-zinc-500 dark:text-zinc-400">
            {report.lines.toLocaleString()} lines · {formatBytes(report.bytes)}
          </span>
        </Mono>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{report.repoName}</span>
        <Button variant="link" className="text-xs" onClick={() => openInEditor(report.path)}>
          Open
        </Button>
      </div>
      {findings.map((f, i) => (
        <div
          key={i}
          className={
            "grid grid-cols-[44px_72px_minmax(0,1fr)] items-baseline gap-3 px-[18px] py-[9px]" +
            (i > 0 ? " border-t border-black/[0.04] dark:border-white/[0.05]" : "")
          }
        >
          <Mono className="text-right text-zinc-500 dark:text-zinc-400">
            {f.line != null ? `L${f.line}` : ""}
          </Mono>
          <Pill tone={f.error ? "rose" : "amber"}>{f.error ? "Error" : "Warning"}</Pill>
          <div className="flex min-w-0 flex-col gap-px">
            <span className="text-[13px] text-zinc-900 dark:text-zinc-100">{f.message}</span>
            <Mono className="text-[11.5px] text-zinc-500 dark:text-zinc-400">{f.rule}</Mono>
          </div>
        </div>
      ))}
    </Card>
  );
}

/**
 * Rephrase the backend's terse issue messages and point stale refs at the
 * line that mentions them (the scanner reports the path, not the line).
 */
function describe(report: ClaudeMdLintReport): Finding[] {
  const lines = report.body.split("\n");
  return report.issues.map((issue: LintIssue): Finding => {
    switch (issue.kind) {
      case "too-long":
        return {
          line: MAX_LINES + 1,
          error: false,
          message: `CLAUDE.md is ${report.lines.toLocaleString()} lines; Claude stops reading after line ${MAX_LINES}`,
          rule: issue.kind,
        };
      case "large-file":
        return {
          line: null,
          error: false,
          message: `CLAUDE.md is ${formatBytes(report.bytes)}, over the ${MAX_BYTES / 1000} KB guideline`,
          rule: issue.kind,
        };
      case "stale-ref": {
        const ref = /"(.+)"/.exec(issue.message)?.[1];
        const idx = ref ? lines.findIndex((l) => l.includes(ref)) : -1;
        return {
          line: idx >= 0 ? idx + 1 : null,
          error: true,
          message: ref ? `Mentions ${ref} which no longer exists` : issue.message,
          rule: issue.kind,
        };
      }
      default:
        return { line: null, error: false, message: issue.message, rule: issue.kind };
    }
  });
}

/** Short version for the in-app assistant — paths and issues, no file bodies. */
function buildAssistantPrompt(reports: ClaudeMdLintReport[]): string {
  const lines = [
    "A linter flagged these CLAUDE.md files (project instructions for Claude Code). For each issue, tell me whether it's real and the exact change to make, grouped by file.",
    "",
  ];
  for (const r of reports) {
    lines.push(`${r.repoName} — ${r.path} (${r.lines} lines, ${formatBytes(r.bytes)})`);
    for (const f of describe(r)) {
      lines.push(`- ${f.line != null ? `L${f.line}: ` : ""}${f.message} [${f.rule}]`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildLlmPrompt(reports: ClaudeMdLintReport[]): string {
  const lines: string[] = [];
  lines.push(
    "I have CLAUDE.md files (project instructions for the Claude Code CLI) across several repos. A linter has flagged issues in some of them. For each issue, tell me:",
  );
  lines.push("");
  lines.push(
    "1. Why the issue is likely there (e.g. file was renamed/moved/deleted, content drifted, command was renamed, section is no longer relevant).",
  );
  lines.push(
    "2. Whether it is genuinely stale/problematic or a false positive the linter cannot verify.",
  );
  lines.push(
    "3. The concrete fix — exact lines to delete, replace, or rewrite. Group by file.",
  );
  lines.push("");
  lines.push(
    "Issue kinds: `stale-ref` = a path/filename mentioned in CLAUDE.md does not exist in the repo; `too-long` = the file is unusually long for project instructions; `large-file` = file size is large in bytes.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const r of reports) {
    lines.push(`## ${r.repoName}`);
    lines.push(`- Repo path: \`${r.repoPath}\``);
    lines.push(`- CLAUDE.md path: \`${r.path}\``);
    lines.push(`- Size: ${r.lines.toLocaleString()} lines, ${formatBytes(r.bytes)}`);
    lines.push("");
    lines.push("### Issues");
    for (const issue of r.issues) {
      lines.push(`- [${issue.kind}] ${issue.message}`);
    }
    lines.push("");
    lines.push("### CLAUDE.md content");
    lines.push("```markdown");
    lines.push(r.body);
    lines.push("```");
    lines.push("");
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

function LintSkeleton() {
  return (
    <Page>
      <PageLoading caption="Checking your CLAUDE.md files…">
        <Bone className="h-7 w-24 rounded-md" />
        <Bone className="h-4 w-80 rounded-md" />
        {[2, 1, 3].map((n, i) => (
          <Bone key={i} className={n === 1 ? "h-24" : n === 2 ? "h-32" : "h-40"} />
        ))}
      </PageLoading>
    </Page>
  );
}
