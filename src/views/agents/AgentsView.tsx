import { Bot } from "lucide-react";
import { queries } from "@/lib/queries";
import { ArtifactInventoryView } from "@/views/_shared/ArtifactInventoryView";
import { modelLabel } from "@/views/_shared/agentLabels";

export function AgentsView() {
  return (
    <ArtifactInventoryView
      title="Subagents"
      lead={(items) => (
        <>
          Helpers your main agent can hand work to. <b>{items.length} set up</b>, each with its
          own instructions and tools.
        </>
      )}
      searchPlaceholder="Find a subagent"
      plural="subagents"
      empty={{
        icon: Bot,
        title: "No subagents yet",
        body: "Subagents are helpers your main agent can hand work to, such as a code reviewer that can only read files.",
      }}
      // Subagents live under ~/.claude/agents — purely a Claude Code feature today.
      claudeOnlyDescription="Subagent files live under ~/.claude/agents. Install Claude Code to set them up and browse them here."
      meta={(a) => `${modelLabel(a.model) ?? "Main agent's model"} · ${toolAccess(a.tools)}`}
      listQuery={queries.agents}
      bodyQuery={queries.agentBody}
    />
  );
}

/**
 * Plain summary of a subagent's `tools:` frontmatter. No list means the
 * subagent inherits every tool the main agent has.
 */
function toolAccess(tools: string | null): string {
  if (!tools?.trim()) return "can use every tool";
  const list = tools.split(/\s*,\s*/).filter(Boolean);
  const has = (re: RegExp) => list.some((t) => re.test(t));
  const edit = has(/^(Edit|Write|MultiEdit|NotebookEdit)\b/);
  const read = has(/^(Read|Grep|Glob|LS|NotebookRead)\b/);
  const run = has(/^Bash\b/);
  const web = has(/^Web(Fetch|Search)\b/);
  const mcp = [
    ...new Set(list.filter((t) => t.startsWith("mcp__")).map((t) => t.split("__")[1])),
  ];
  if (!edit && !run && !web && mcp.length === 0) return read ? "read-only" : `can use ${list.join(", ")}`;
  const parts: string[] = [];
  if (edit) parts.push("edit files");
  else if (read) parts.push("read files");
  if (run) parts.push("run commands");
  if (web) parts.push("search the web");
  for (const m of mcp) parts.push(`use ${m}`);
  return `can ${joinAnd(parts)}`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
