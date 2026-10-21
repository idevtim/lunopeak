import type { AssistantProvider, Settings } from "@/types/api";
import type { ChatMessage, StopReason, TextBlock } from "@/types/assistant";
import { TOOLS } from "@/lib/assistantTools";
import { sendAnthropic } from "./anthropic";
import { sendOpenai } from "./openai";
import { sendGemini } from "./gemini";
import { sendXai } from "./xai";
import {
  DEFAULT_OLLAMA_ENDPOINT,
  normalizeEndpoint,
  sendOllama,
} from "./ollama";

export const SYSTEM_PROMPT = `You are the assistant inside LunoPeak — a local-first dashboard that gives the user a unified view of their AI-assisted dev environment. You can call tools to read live data about their repos, AI coding sessions (Claude Code, Codex, and Cursor — whichever the user runs), costs, hygiene flags, and live processes — all of which lives only on their machine.

Style:
- Be concise. Lead with the answer, not a recap of what they asked.
- When you cite numbers, format USD as $X.XX, big counts with K/M, and durations in plain English.
- When listing repos / sessions, top 5 is usually enough unless they ask for more.
- If a tool errors or returns nothing, say so plainly — don't invent.

Capabilities you CAN'T do:
- Modify any file or run any command. Read-only.
- Install dependencies, edit configs, or change settings.

If the user wants any of those, tell them which view in the app to open.`;

export interface SendOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** Override the default system prompt. Used by `generateTitle`. */
  systemOverride?: string;
  /** Skip sending tool definitions. Used by `generateTitle`. */
  noTools?: boolean;
}

export interface SendResult {
  message: ChatMessage;
  stopReason: StopReason;
}

export interface ProviderModel {
  id: string;
  label: string;
}

export const PROVIDER_LABELS: Record<AssistantProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  xai: "xAI",
  ollama: "Ollama",
};

/**
 * Curated model lists per provider. Ollama is intentionally empty here —
 * the actual model list comes from the user's local daemon (`/api/tags`)
 * and is fetched lazily by the UI.
 */
export const PROVIDER_MODELS: Record<AssistantProvider, readonly ProviderModel[]> = {
  anthropic: [
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-sonnet-5", label: "Sonnet 5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
    // Mythos 5.1 is priced and tracked in Costs, but stays out of this picker:
    // it's reachable only through Project Glasswing, so listing it would offer
    // most users a model their key can't call.
  ],
  openai: [
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ],
  gemini: [
    { id: "gemini-2.5-pro", label: "2.5 Pro" },
    { id: "gemini-2.5-flash", label: "2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "2.5 Flash-Lite" },
  ],
  xai: [
    { id: "grok-4.5", label: "Grok 4.5" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.7", label: "Grok 4.7" },
  ],
  ollama: [],
};

export const DEFAULT_MODEL_FOR: Record<AssistantProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-sol",
  gemini: "gemini-2.5-pro",
  xai: "grok-4.7",
  // Reasonable fallback when the daemon is reachable but reports no models.
  // The UI will replace this with the first installed model whenever one
  // exists.
  ollama: "llama3.2",
};

export const KEY_PLACEHOLDERS: Record<AssistantProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  gemini: "AI...",
  xai: "xai-...",
  ollama: "http://localhost:11434",
};

/**
 * Resolve the credential the chat call needs for `provider`. For cloud
 * providers this is the API key; for Ollama it's the daemon's base URL,
 * which is always populated (defaults to `http://localhost:11434`).
 */
export function getProviderCredential(
  settings: Settings | null | undefined,
  provider: AssistantProvider,
): string | null {
  if (!settings) return null;
  if (provider === "ollama") {
    return normalizeEndpoint(settings.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT);
  }
  return settings.apiKeys[provider] ?? null;
}

/** Pick the user's saved model only if it's valid for the current provider. */
export function modelForProvider(
  provider: AssistantProvider,
  model: string,
): string {
  // Ollama models are user-installed locally, so there is no static
  // allowlist to validate against. Pass through whatever the user picked
  // and fall back to the placeholder default only when nothing is set.
  if (provider === "ollama") return model || DEFAULT_MODEL_FOR.ollama;
  const list = PROVIDER_MODELS[provider];
  return list.some((m) => m.id === model) ? model : DEFAULT_MODEL_FOR[provider];
}

export async function sendMessage(
  provider: AssistantProvider,
  opts: SendOptions,
): Promise<SendResult> {
  const model = modelForProvider(provider, opts.model);
  const args = {
    ...opts,
    model,
    system: opts.systemOverride ?? SYSTEM_PROMPT,
    tools: opts.noTools ? [] : TOOLS,
  };
  switch (provider) {
    case "anthropic":
      return sendAnthropic(args);
    case "openai":
      return sendOpenai(args);
    case "gemini":
      return sendGemini(args);
    case "xai":
      return sendXai(args);
    case "ollama":
      return sendOllama(args);
  }
}

const TITLE_SYSTEM = `You generate a short, descriptive title (3 to 5 words, max 6) summarizing what the user is asking about. Respond with ONLY the title — no quotes, no trailing punctuation, no preamble. Use Title Case.`;

/**
 * One-shot call to the same provider/model to summarize the user's first
 * message into a sidebar-friendly title. Best-effort: callers should treat
 * failures as silent (fall back to the truncated-first-message placeholder).
 */
export async function generateTitle(
  provider: AssistantProvider,
  opts: { apiKey: string; model: string; userMessage: string; signal?: AbortSignal },
): Promise<string> {
  const result = await sendMessage(provider, {
    apiKey: opts.apiKey,
    model: opts.model,
    signal: opts.signal,
    systemOverride: TITLE_SYSTEM,
    noTools: true,
    messages: [{ role: "user", content: opts.userMessage }],
  });

  const content = result.message.content;
  const raw =
    typeof content === "string"
      ? content
      : (content.find((b): b is TextBlock => b.type === "text")?.text ?? "");

  return cleanTitle(raw);
}

function cleanTitle(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[.!?,;:]+$/, "")
    .replace(/\s+/g, " ");
  return cleaned.length > 60 ? `${cleaned.slice(0, 60)}…` : cleaned;
}
