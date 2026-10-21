import type {
  ChatMessage,
  ContentBlock,
  StopReason,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@/types/assistant";
import type { TOOLS } from "@/lib/assistantTools";

interface SendArgs {
  /** For Ollama this carries the base URL (e.g. http://localhost:11434). */
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  system: string;
  tools: readonly (typeof TOOLS)[number][];
  signal?: AbortSignal;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: {
    role: "assistant";
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done_reason?: string;
  done?: boolean;
}

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: {
      family?: string;
      parameter_size?: string;
    };
  }>;
}

export interface OllamaModel {
  name: string;
  paramSize: string | null;
  family: string | null;
}

export const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";

export function normalizeEndpoint(raw: string | null | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_OLLAMA_ENDPOINT;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Cheap reachability probe used for first-run detection and "test connection"
 * in Settings. Resolves to true iff /api/tags responds with 2xx within the
 * caller's signal/abort window.
 */
export async function pingOllama(
  endpoint: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeEndpoint(endpoint)}/api/tags`, {
      method: "GET",
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listOllamaModels(
  endpoint: string,
  signal?: AbortSignal,
): Promise<OllamaModel[]> {
  const res = await fetch(`${normalizeEndpoint(endpoint)}/api/tags`, {
    method: "GET",
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: couldn't list models`);
  const data = (await res.json()) as OllamaTagsResponse;
  return (data.models ?? []).map((m) => ({
    name: m.name,
    paramSize: m.details?.parameter_size ?? null,
    family: m.details?.family ?? null,
  }));
}

export async function sendOllama({
  apiKey: endpoint,
  model,
  messages,
  system,
  tools,
  signal,
}: SendArgs): Promise<{ message: ChatMessage; stopReason: StopReason }> {
  const idToName = collectToolCallNames(messages);

  const payloadMessages: OllamaMessage[] = [
    { role: "system", content: system },
    ...messages.flatMap((m) => toOllama(m, idToName)),
  ];

  const res = await fetch(`${normalizeEndpoint(endpoint)}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: payloadMessages,
      stream: false,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              },
            })),
          }
        : {}),
    }),
    signal,
  });

  if (!res.ok) throw new Error(await formatError(res, endpoint));

  const data = (await res.json()) as OllamaChatResponse;
  const msg = data.message;
  if (!msg) throw new Error("Ollama returned no message");

  const blocks: ContentBlock[] = [];
  if (msg.content && msg.content.trim()) {
    blocks.push({ type: "text", text: msg.content } satisfies TextBlock);
  }
  for (const call of msg.tool_calls ?? []) {
    const args =
      typeof call.function.arguments === "string"
        ? safeJson(call.function.arguments)
        : (call.function.arguments ?? {});
    blocks.push({
      type: "tool_use",
      id: synthesizeId(),
      name: call.function.name,
      input: args,
    } satisfies ToolUseBlock);
  }

  const stopReason: StopReason = blocks.some((b) => b.type === "tool_use")
    ? "tool_use"
    : data.done_reason === "length"
      ? "max_tokens"
      : "end_turn";

  return {
    message: { role: "assistant", content: blocks },
    stopReason,
  };
}

// Ollama's tool-call wire format echoes a `tool_use_id`-less convention where
// each `role: "tool"` message must carry the original `tool_name`. We keep our
// internal Anthropic-style tool_use_id for the rest of the app and look up the
// matching name from the prior assistant turn at serialize time.
function collectToolCallNames(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === "tool_use") map.set(block.id, block.name);
    }
  }
  return map;
}

function toOllama(
  msg: ChatMessage,
  idToName: Map<string, string>,
): OllamaMessage[] {
  if (msg.role === "user" && typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  if (msg.role === "user" && Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is ToolResultBlock => b.type === "tool_result")
      .map((b) => ({
        role: "tool" as const,
        tool_name: idToName.get(b.tool_use_id) ?? "unknown",
        content: b.content,
      }));
  }

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    const text = msg.content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const toolCalls = msg.content
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        function: { name: b.name, arguments: b.input ?? {} },
      }));
    const out: OllamaMessage = { role: "assistant", content: text };
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    return [out];
  }

  return [];
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { _raw: raw };
  } catch {
    return { _raw: raw };
  }
}

function synthesizeId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `call_${rand}`;
}

async function formatError(res: Response, endpoint: string): Promise<string> {
  if (res.status === 404) {
    return `Ollama at ${endpoint} doesn't have that model installed. Run \`ollama pull <model>\` and try again.`;
  }
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) return `Ollama ${res.status}: ${parsed.error}`;
  } catch {
    // fall through
  }
  return `Ollama API error ${res.status}`;
}
