import { Wand2 } from "lucide-react";
import { queries } from "@/lib/queries";
import { plural } from "@/lib/format";
import { ArtifactInventoryView } from "@/views/_shared/ArtifactInventoryView";

export function SkillsView() {
  return (
    <ArtifactInventoryView
      title="Skills"
      lead={(items) => (
        <>
          <b>{plural(items.length, "skill")}</b> Claude can load when a task needs them.
        </>
      )}
      searchPlaceholder="Find a skill"
      plural="skills"
      empty={{
        icon: Wand2,
        title: "No skills yet",
        body: "Skills are instructions Claude loads only when a task needs them, like how to write your release notes.",
      }}
      // Skills are a Claude Code primitive — Codex and Cursor have no parallel.
      claudeOnlyDescription="Skill files live under ~/.claude/skills. Install Claude Code to write and browse them here."
      listQuery={queries.skills}
      bodyQuery={queries.skillBody}
    />
  );
}
