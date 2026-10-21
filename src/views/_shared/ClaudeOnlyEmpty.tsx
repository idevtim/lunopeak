import { Info } from "lucide-react";
import { EmptyState } from "@/components/ui/PageStates";

/**
 * Explanatory empty state shown by views whose data only comes from Claude
 * Code (Memory, Lint, etc.) when the user doesn't have Claude Code installed.
 * Tells them why the view is empty so they don't assume it's broken — and
 * names the upstream cause (CLAUDE.md, ~/.claude/) so power users know what
 * to fix if they want to populate it.
 */
export function ClaudeOnlyEmpty({
  feature,
  description,
}: {
  feature: string;
  description: string;
}) {
  return (
    <EmptyState
      icon={Info}
      title={`${feature[0].toUpperCase() + feature.slice(1)} needs Claude Code`}
      body={description}
    />
  );
}
