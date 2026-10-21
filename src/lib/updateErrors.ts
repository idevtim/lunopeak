/**
 * The updater plugin's raw errors leak HTTP status codes and JSON parse
 * messages — useful in logs, useless in the UI. Map common failure modes to
 * something the user can act on.
 */
export function friendlyUpdateError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("404") || lower.includes("not found")) {
    return "No release published yet.";
  }
  if (
    lower.includes("could not fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("dns") ||
    lower.includes("connection")
  ) {
    return "Couldn't reach the update server.";
  }
  if (lower.includes("signature") || lower.includes("pubkey")) {
    return "Update signature couldn't be verified.";
  }
  if (lower.includes("json") || lower.includes("parse")) {
    return "Update manifest is malformed.";
  }
  return message;
}
