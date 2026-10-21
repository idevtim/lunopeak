import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChatMessage, ContentBlock } from "@/types/assistant";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  // Set true once the user manually renames the conversation. Auto-titling
  // (placeholder + LLM-generated smart title) checks this flag before
  // overwriting, so a user-chosen name always wins.
  userRenamed?: boolean;
}

interface AssistantState {
  conversations: Conversation[];
  currentId: string | null;
  isThinking: boolean;
  error: string | null;

  setMessages: (messages: ChatMessage[]) => void;
  newConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  /** Apply an LLM-generated title — only if the user hasn't manually renamed. */
  applyAutoTitle: (id: string, title: string) => void;
  clearCurrent: () => void;
  setThinking: (v: boolean) => void;
  setError: (e: string | null) => void;
  /**
   * Hydrate the store with prebuilt conversations (used by demo mode to
   * seed history for screenshots). No-op once any conversation exists, so
   * a user's real history is never overwritten.
   */
  seedDemo: (conversations: Conversation[], currentId: string | null) => void;
}

const newId = () =>
  `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const firstUserText = (messages: ChatMessage[]): string | null => {
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const text = (m.content as ContentBlock[]).find((b) => b.type === "text");
    if (text && text.type === "text") return text.text;
  }
  return null;
};

const titleFromMessages = (messages: ChatMessage[]): string => {
  const text = firstUserText(messages);
  if (!text) return "New chat";
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
};

const makeConversation = (): Conversation => {
  const now = Date.now();
  return {
    id: newId(),
    title: "New chat",
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
};

export const useAssistantStore = create<AssistantState>()(
  persist(
    (set, get) => ({
      conversations: [],
      currentId: null,
      isThinking: false,
      error: null,

      setMessages: (messages) =>
        set((s) => {
          const now = Date.now();
          let conversations = s.conversations;
          let id = s.currentId;

          if (!id || !conversations.some((c) => c.id === id)) {
            const fresh = makeConversation();
            id = fresh.id;
            conversations = [fresh, ...conversations];
          }

          conversations = conversations.map((c) => {
            if (c.id !== id) return c;
            // Set a placeholder title from the first user message only on the
            // very first send (when title is still "New chat"). Subsequent
            // sends leave the title alone so applyAutoTitle (smart title) and
            // user renames stick.
            const lockedByUser = c.userRenamed === true;
            const isPlaceholder = c.title === "New chat" || c.title.trim() === "";
            return {
              ...c,
              messages,
              updatedAt: now,
              title:
                !lockedByUser && isPlaceholder
                  ? titleFromMessages(messages)
                  : c.title,
            };
          });

          return { conversations, currentId: id };
        }),

      newConversation: () => {
        const fresh = makeConversation();
        set((s) => ({
          conversations: [fresh, ...s.conversations],
          currentId: fresh.id,
          error: null,
          isThinking: false,
        }));
        return fresh.id;
      },

      selectConversation: (id) => {
        if (!get().conversations.some((c) => c.id === id)) return;
        set({ currentId: id, error: null });
      },

      deleteConversation: (id) =>
        set((s) => {
          const conversations = s.conversations.filter((c) => c.id !== id);
          let currentId = s.currentId;
          if (currentId === id) {
            currentId = conversations[0]?.id ?? null;
          }
          return { conversations, currentId };
        }),

      renameConversation: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id
              ? { ...c, title: title.trim() || "Untitled", userRenamed: true }
              : c,
          ),
        })),

      applyAutoTitle: (id, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === id && !c.userRenamed && title.trim()
              ? { ...c, title: title.trim() }
              : c,
          ),
        })),

      clearCurrent: () =>
        set((s) => {
          if (!s.currentId) return { error: null, isThinking: false };
          return {
            conversations: s.conversations.map((c) =>
              c.id === s.currentId
                ? { ...c, messages: [], title: "New chat", updatedAt: Date.now() }
                : c,
            ),
            error: null,
            isThinking: false,
          };
        }),

      setThinking: (v) => set({ isThinking: v }),
      setError: (e) => set({ error: e }),

      seedDemo: (conversations, currentId) =>
        set((s) => {
          if (s.conversations.length > 0) return s;
          return { conversations, currentId };
        }),
    }),
    {
      name: "lunopeak.assistant",
      storage: createJSONStorage(() => localStorage),
      version: 2,
      partialize: (s) => ({
        conversations: s.conversations,
        currentId: s.currentId,
      }),
      migrate: (persisted, version) => {
        if (version < 2 && persisted && typeof persisted === "object") {
          const old = persisted as { messages?: ChatMessage[] };
          if (Array.isArray(old.messages) && old.messages.length > 0) {
            const now = Date.now();
            const conv: Conversation = {
              id: newId(),
              title: titleFromMessages(old.messages),
              messages: old.messages,
              createdAt: now,
              updatedAt: now,
            };
            return { conversations: [conv], currentId: conv.id };
          }
          return { conversations: [], currentId: null };
        }
        return persisted as AssistantState;
      },
    },
  ),
);

export const selectCurrentMessages = (s: AssistantState): ChatMessage[] => {
  const c = s.conversations.find((x) => x.id === s.currentId);
  return c?.messages ?? [];
};
