import type {
  ChatMessage,
  ContentBlock,
  StopReason,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@/types/assistant";
import type { TOOLS } from "@/lib/assistantTools";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface SendArgs {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  system: string;
  tools: readonly (typeof TOOLS)[number][];
  signal?: AbortSignal;
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
}

export async function sendGemini({
  apiKey,
  model,
  messages,
  system,
  tools,
  signal,
}: SendArgs): Promise<{ message: ChatMessage; stopReason: StopReason }> {
  // Gemini doesn't track tool-call IDs, so we look up the matching tool name
  // from the prior assistant message when serializing tool_result blocks.
  const idToName = collectToolCallNames(messages);

  const contents: GeminiContent[] = messages
    .map((m) => toGemini(m, idToName))
    .filter((c): c is GeminiContent => c !== null);

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    ...(tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: sanitizeSchema(t.input_schema),
              })),
            },
          ],
        }
      : {}),
  };

  const res = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new Error(await formatError(res));

  const data = (await res.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const blocks = fromGemini(parts);
  const stopReason = mapStopReason(candidate?.finishReason, blocks);

  return {
    message: { role: "assistant", content: blocks },
    stopReason,
  };
}

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

function toGemini(
  msg: ChatMessage,
  idToName: Map<string, string>,
): GeminiContent | null {
  if (msg.role === "user" && typeof msg.content === "string") {
    return { role: "user", parts: [{ text: msg.content }] };
  }

  if (msg.role === "user" && Array.isArray(msg.content)) {
    const parts: GeminiPart[] = msg.content
      .filter((b): b is ToolResultBlock => b.type === "tool_result")
      .map((b) => ({
        functionResponse: {
          name: idToName.get(b.tool_use_id) ?? "unknown",
          response: b.is_error
            ? { error: b.content }
            : { content: b.content },
        },
      }));
    return parts.length > 0 ? { role: "user", parts } : null;
  }

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    const parts: GeminiPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use") {
        parts.push({
          functionCall: { name: block.name, args: block.input ?? {} },
        });
      }
    }
    return parts.length > 0 ? { role: "model", parts } : null;
  }

  return null;
}

function fromGemini(parts: GeminiPart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (part.text) {
      blocks.push({ type: "text", text: part.text } satisfies TextBlock);
    } else if (part.functionCall) {
      blocks.push({
        type: "tool_use",
        id: synthesizeId(),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      } satisfies ToolUseBlock);
    }
  }
  return blocks;
}

function synthesizeId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `call_${rand}`;
}

function mapStopReason(
  reason: string | undefined,
  blocks: ContentBlock[],
): StopReason {
  if (blocks.some((b) => b.type === "tool_use")) return "tool_use";
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return reason ?? "end_turn";
  }
}

/** Gemini rejects some JSON Schema keywords (e.g. additionalProperties). */
function sanitizeSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = sanitizeSchema(v);
  }
  return out;
}

async function formatError(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403)
    return "Invalid Gemini API key. Check Settings.";
  if (res.status === 429) return "Rate limited by Gemini. Try again in a moment.";
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return `Gemini ${res.status}: ${parsed.error.message}`;
  } catch {
    // fall through
  }
  return `Gemini API error ${res.status}`;
}
