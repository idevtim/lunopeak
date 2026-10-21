import type { ChatMessage, ContentBlock, StopReason } from "@/types/assistant";
import type { TOOLS } from "@/lib/assistantTools";

const URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

interface SendArgs {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  system: string;
  tools: readonly (typeof TOOLS)[number][];
  signal?: AbortSignal;
}

interface AnthropicResponse {
  id: string;
  content: ContentBlock[];
  stop_reason: StopReason;
  model: string;
}

export async function sendAnthropic({
  apiKey,
  model,
  messages,
  system,
  tools,
  signal,
}: SendArgs): Promise<{ message: ChatMessage; stopReason: StopReason }> {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": VERSION,
      "content-type": "application/json",
      // Required by Anthropic for direct browser/desktop calls. The key is
      // already on the user's machine — no extra exposure happens here.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      ...(tools.length > 0 ? { tools } : {}),
      messages,
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(await formatError(res));
  }

  const data = (await res.json()) as AnthropicResponse;
  return {
    message: { role: "assistant", content: data.content },
    stopReason: data.stop_reason,
  };
}

async function formatError(res: Response): Promise<string> {
  if (res.status === 401) return "Invalid Anthropic API key. Check Settings.";
  if (res.status === 429) return "Rate limited by Anthropic. Try again in a moment.";
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return `Anthropic ${res.status}: ${parsed.error.message}`;
  } catch {
    // fall through
  }
  return `Anthropic API error ${res.status}`;
}
