/**
 * Plain-language labels for raw agent config values (model ids, permission
 * modes, approval policies). The raw value is still shown small and mono
 * next to these — this is the "plain words first" half.
 */

/** "opus" → "Opus", "claude-sonnet-4-5" → "Sonnet", "gpt-5-codex" → "GPT-5 Codex". */
export function modelLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().toLowerCase();
  if (m === "inherit") return "Same model as main agent";
  if (m === "default") return "Default";
  if (m === "opusplan") return "Opus for planning, then Sonnet";
  const family = /(opus|sonnet|haiku)/.exec(m)?.[1];
  if (family) return family[0].toUpperCase() + family.slice(1);
  if (m.startsWith("gpt-")) {
    const [ver, ...rest] = m.slice(4).split("-");
    return ["GPT-" + ver, ...rest.map(cap)].join(" ");
  }
  return raw;
}

/** Claude Code `permissions.defaultMode`. */
export function permissionModeLabel(mode: string | null | undefined): string {
  switch (mode ?? "default") {
    case "default":
      return "Ask before editing files";
    case "acceptEdits":
      return "Edits files without asking";
    case "plan":
      return "Plans only, no edits";
    case "bypassPermissions":
      return "Never asks";
    case "dontAsk":
      return "Only runs pre-approved tools";
    default:
      return mode!;
  }
}

/** Codex `approval_policy`. */
export function approvalPolicyLabel(policy: string | null | undefined): string {
  switch (policy) {
    case null:
    case undefined:
      return "Default";
    case "untrusted":
      return "Ask before running commands";
    case "on-request":
      return "Asks when it needs more access";
    case "on-failure":
      return "Asks if a command fails";
    case "never":
      return "Never asks";
    default:
      return policy;
  }
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
