import type {
  ChatMessage,
  ContentBlock,
  StopReason,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@/types/assistant";
import type { TOOLS } from "@/lib/assistantTools";

const URL = "https://api.openai.com/v1/chat/completions";

/**
 * A vendor that speaks OpenAI's Chat Completions wire format. xAI's Grok API
 * mirrors it, so one client serves both — only the endpoint and the name in
 * error messages differ.
 */
export interface ChatCompletionsVendor {
  url: string;
  name: string;
}

const OPENAI: ChatCompletionsVendor = { url: URL, name: "OpenAI" };

export interface SendArgs {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  system: string;
  tools: readonly (typeof TOOLS)[number][];
  signal?: AbortSignal;
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
}

interface OpenAiResponse {
  choices: Array<{
    message: OpenAiAssistantMessage;
    finish_reason: string;
  }>;
}

export function sendOpenai(
  args: SendArgs,
): Promise<{ message: ChatMessage; stopReason: StopReason }> {
  return sendChatCompletions(args, OPENAI);
}

export async function sendChatCompletions(
  { apiKey, model, messages, system, tools, signal }: SendArgs,
  vendor: ChatCompletionsVendor,
): Promise<{ message: ChatMessage; stopReason: StopReason }> {
  const res = await fetch(vendor.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        ...messages.flatMap(toOpenAi),
      ],
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

  if (!res.ok) throw new Error(await formatError(res, vendor.name));

  const data = (await res.json()) as OpenAiResponse;
  const choice = data.choices[0];
  if (!choice) throw new Error(`${vendor.name} returned no choices`);

  return {
    message: { role: "assistant", content: fromOpenAi(choice.message) },
    stopReason: mapStopReason(choice.finish_reason),
  };
}

function toOpenAi(msg: ChatMessage): unknown[] {
  if (msg.role === "user" && typeof msg.content === "string") {
    return [{ role: "user", content: msg.content }];
  }

  if (msg.role === "user" && Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is ToolResultBlock => b.type === "tool_result")
      .map((b) => ({
        role: "tool",
        tool_call_id: b.tool_use_id,
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
        id: b.id,
        type: "function" as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        },
      }));
    const out: Record<string, unknown> = {
      role: "assistant",
      content: text || null,
    };
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    return [out];
  }

  return [];
}

function fromOpenAi(msg: OpenAiAssistantMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg.content) {
    blocks.push({ type: "text", text: msg.content });
  }
  for (const call of msg.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = call.function.arguments
        ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
        : {};
    } catch {
      // model returned malformed JSON; pass through as raw string
      input = { _raw: call.function.arguments };
    }
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    });
  }
  return blocks;
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return reason;
  }
}

async function formatError(res: Response, name: string): Promise<string> {
  if (res.status === 401) return `Invalid ${name} API key. Check Settings.`;
  if (res.status === 429) return `Rate limited by ${name}. Try again in a moment.`;
  const body = await res.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return `${name} ${res.status}: ${parsed.error.message}`;
  } catch {
    // fall through
  }
  return `${name} API error ${res.status}`;
}
