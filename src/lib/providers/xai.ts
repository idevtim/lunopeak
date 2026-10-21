import type { ChatMessage, StopReason } from "@/types/assistant";
import { sendChatCompletions, type SendArgs } from "./openai";

/**
 * xAI's Grok API is wire-compatible with OpenAI Chat Completions (same
 * request, tool-call, and finish_reason shapes), so it reuses that client
 * with xAI's endpoint.
 */
const XAI = { url: "https://api.x.ai/v1/chat/completions", name: "xAI" };

export function sendXai(
  args: SendArgs,
): Promise<{ message: ChatMessage; stopReason: StopReason }> {
  return sendChatCompletions(args, XAI);
}
