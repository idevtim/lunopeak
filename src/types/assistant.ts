/**
 * Wire-format types matching Anthropic's Messages API. We store these
 * directly so we can re-send the entire conversation as-is on each turn.
 */

export type ChatRole = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentBlock[];
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | (string & {});
