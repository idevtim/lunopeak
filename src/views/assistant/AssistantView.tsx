import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useHashRoute } from "@/hooks/useHashRoute";
import {
  ArrowUp,
  Check,
  ChevronRight,
  Eye,
  KeyRound,
  Pencil,
  Plus,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import {
  DEFAULT_MODEL_FOR,
  PROVIDER_LABELS,
  generateTitle,
  getProviderCredential,
  modelForProvider,
  sendMessage,
} from "@/lib/providers";
import {
  DEFAULT_OLLAMA_ENDPOINT,
  listOllamaModels,
  pingOllama,
} from "@/lib/providers/ollama";
import { executeTool } from "@/lib/assistantTools";
import { useAssistantStore, type Conversation } from "@/stores/assistantStore";
import { confirm } from "@/stores/confirmStore";
import { useOnline } from "@/hooks/useOnline";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { ModelPicker } from "./ModelPicker";
import { LiveDot } from "@/components/ui/LiveDot";
import { Markdown } from "@/components/ui/Markdown";
import { Page, PageHeader } from "@/components/ui/Page";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { cn } from "@/lib/utils";
import type { AssistantProvider } from "@/types/api";
import type {
  ChatMessage,
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@/types/assistant";

const TOOL_LOOP_LIMIT = 6;

export function AssistantView() {
  const qc = useQueryClient();
  const settings = useQuery(queries.settings);
  const showSkeleton = useDelayedLoading(settings.isLoading);
  const provider: AssistantProvider = settings.data?.provider ?? "anthropic";
  const apiKey = getProviderCredential(settings.data, provider);
  const model = modelForProvider(
    provider,
    settings.data?.defaultModel ?? "",
  );

  // First-run Ollama auto-detect: when settings.json was just created and
  // the user hasn't configured any cloud provider yet, probe localhost for a
  // running Ollama daemon. If reachable, switch the default provider to it
  // and pick the first installed model so the chat works out of the box.
  // Always clears `firstRun` so the probe doesn't re-fire.
  const ranFirstProbeRef = useRef(false);
  useEffect(() => {
    if (!settings.data || !settings.data.firstRun) return;
    if (ranFirstProbeRef.current) return;
    ranFirstProbeRef.current = true;

    const s = settings.data;
    const hasAnyCloudKey = Object.values(s.apiKeys).some(
      (v) => typeof v === "string" && v.trim().length > 0,
    );

    void (async () => {
      const endpoint = s.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT;
      let next = { ...s, firstRun: false };
      if (!hasAnyCloudKey) {
        const reachable = await pingOllama(endpoint);
        if (reachable) {
          try {
            const models = await listOllamaModels(endpoint);
            const first = models[0]?.name;
            next = {
              ...next,
              provider: "ollama",
              defaultModel: first ?? DEFAULT_MODEL_FOR.ollama,
            };
          } catch {
            // Daemon up but /api/tags failed — still flip provider so the
            // user sees Ollama as the default. They can pick a model from
            // the dropdown once it loads.
            next = { ...next, provider: "ollama" };
          }
        }
      }
      try {
        await api.updateSettings(next);
      } finally {
        qc.invalidateQueries({ queryKey: queries.settings.queryKey });
      }
    })();
  }, [settings.data, qc]);

  const conversations = useAssistantStore((s) => s.conversations);
  const currentId = useAssistantStore((s) => s.currentId);
  const isThinking = useAssistantStore((s) => s.isThinking);
  const error = useAssistantStore((s) => s.error);
  const setMessages = useAssistantStore((s) => s.setMessages);
  const setThinking = useAssistantStore((s) => s.setThinking);
  const setError = useAssistantStore((s) => s.setError);
  const newConversation = useAssistantStore((s) => s.newConversation);
  const selectConversation = useAssistantStore((s) => s.selectConversation);
  const deleteConversation = useAssistantStore((s) => s.deleteConversation);
  const renameConversation = useAssistantStore((s) => s.renameConversation);
  const applyAutoTitle = useAssistantStore((s) => s.applyAutoTitle);
  const clearCurrent = useAssistantStore((s) => s.clearCurrent);

  const messages = useMemo(
    () => conversations.find((c) => c.id === currentId)?.messages ?? [],
    [conversations, currentId],
  );

  const online = useOnline();
  // Ollama runs on localhost — works without internet. Cloud providers don't.
  const requiresInternet = provider !== "ollama";
  const offlineBlocked = requiresInternet && !online;

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // AbortController for the in-flight provider request + tool loop. The Stop
  // button calls .abort(); the loop checks `signal.aborted` between hops so
  // a mid-tool-call stop also unwinds cleanly.
  const abortRef = useRef<AbortController | null>(null);

  // Autoscroll on new messages / thinking state
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, isThinking]);

  // Reset input focus when switching conversations
  useEffect(() => {
    inputRef.current?.focus();
  }, [currentId]);

  const handleSend = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || isThinking || !apiKey) return;

      if (offlineBlocked) {
        setError(
          `You're offline — ${PROVIDER_LABELS[provider]} can't be reached. Reconnect or switch to Ollama (local).`,
        );
        return;
      }

      setError(null);
      if (!override) setInput("");

      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      // Capture before we mutate — used to trigger smart-titling exactly once
      // per conversation, on its very first user turn.
      const isFirstUserMessage = messages.length === 0;

      const userMsg: ChatMessage = { role: "user", content: text };
      let convo: ChatMessage[] = [...messages, userMsg];
      setMessages(convo);
      setThinking(true);

      try {
        let safety = TOOL_LOOP_LIMIT;
        while (safety-- > 0) {
          if (signal.aborted) break;
          const { message, stopReason } = await sendMessage(provider, {
            apiKey,
            model,
            messages: convo,
            signal,
          });
          convo = [...convo, message];
          setMessages(convo);

          if (stopReason !== "tool_use") break;

          const blocks = (message.content as ContentBlock[]).filter(
            (b): b is ToolUseBlock => b.type === "tool_use",
          );
          if (blocks.length === 0) break;

          const resultBlocks: ToolResultBlock[] = await Promise.all(
            blocks.map(async (b) => {
              const r = await executeTool(b.name);
              return {
                type: "tool_result",
                tool_use_id: b.id,
                content: r.content,
                is_error: r.isError,
              };
            }),
          );
          if (signal.aborted) break;
          convo = [...convo, { role: "user", content: resultBlocks }];
          setMessages(convo);
        }

        // Smart title: best-effort, fire-and-forget. Only on the first turn
        // and only if the user didn't stop. Uses a fresh, untracked signal
        // so a later "Stop" on the next request doesn't cancel this.
        if (isFirstUserMessage && !signal.aborted) {
          const conversationId =
            useAssistantStore.getState().currentId ?? null;
          if (conversationId) {
            void generateTitle(provider, {
              apiKey,
              model,
              userMessage: text,
            })
              .then((title) => {
                if (title) applyAutoTitle(conversationId, title);
              })
              .catch(() => {
                /* title gen is best-effort — placeholder title stays */
              });
          }
        }
      } catch (e) {
        // AbortError isn't a real failure — the user asked to stop.
        const isAbort =
          (e instanceof DOMException && e.name === "AbortError") ||
          signal.aborted;
        if (!isAbort) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setThinking(false);
        inputRef.current?.focus();
      }
    },
    [
      apiKey,
      applyAutoTitle,
      input,
      isThinking,
      messages,
      model,
      offlineBlocked,
      provider,
      setError,
      setMessages,
      setThinking,
    ],
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // If the user navigates away or unmounts mid-request, drop the in-flight
  // call so we don't keep paying tokens or hold a dangling fetch.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Auto-send a `?q=...` prompt deep-linked from another view (e.g. Hygiene).
  // Always start a new conversation so the prompt never bleeds into an existing one.
  const { params } = useHashRoute();
  const q = params.get("q");
  const autoSentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!q || !apiKey || isThinking) return;
    if (autoSentRef.current === q) return;
    autoSentRef.current = q;
    const baseHash = window.location.hash.split("?")[0];
    window.history.replaceState(null, "", baseHash);
    newConversation();
    void handleSend(q);
  }, [q, apiKey, isThinking, handleSend, newConversation]);

  if (settings.isLoading) return showSkeleton ? <AssistantSkeleton /> : null;
  if (settings.isError) {
    return (
      <Page>
        <PageHeader title="Assistant" />
        <ErrorState
          title="Couldn't load your assistant settings"
          body="LunoPeak couldn't read its settings file."
          error={settings.error}
          onRetry={() => void settings.refetch()}
        />
      </Page>
    );
  }
  if (!apiKey) return <ApiKeyMissing />;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleNewChat = () => {
    newConversation();
    setInput("");
  };


  const current = conversations.find((c) => c.id === currentId);
  const isEmpty = messages.length === 0 && !isThinking;
  const composer = (
    <Composer
      inputRef={inputRef}
      value={input}
      onChange={setInput}
      onKeyDown={onKeyDown}
      onSend={() => void handleSend()}
      onStop={handleStop}
      isThinking={isThinking}
      offlineHint={
        offlineBlocked ? `Offline · ${PROVIDER_LABELS[provider]} can't be reached` : null
      }
    />
  );

  return (
    <Page className="h-full min-h-[560px] pb-6">
      <PageHeader title="Assistant" lead="Ask questions about your repos, sessions and costs." />
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-[14px] border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-white/[0.035]">
        <ConversationsPanel
          conversations={conversations}
          currentId={currentId}
          onSelect={selectConversation}
          onNew={handleNewChat}
          onDelete={deleteConversation}
          onRename={renameConversation}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2.5 border-b border-black/[0.05] px-6 pb-3 pt-3.5 dark:border-white/[0.06]">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
              {current?.title || "New chat"}
            </span>
            <span
              title="Can look at your repos, sessions and costs. Can't change anything."
              className="inline-flex shrink-0 items-center gap-[5px] rounded-full bg-black/[0.04] px-[9px] py-[3px] text-xs text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-300"
            >
              <Eye size={12} strokeWidth={2} />
              Look only
            </span>
            {settings.data && (
              <ModelPicker
                settings={settings.data}
                onPick={(nextProvider, nextModel) => {
                  if (!settings.data) return;
                  void api
                    .updateSettings({
                      ...settings.data,
                      provider: nextProvider,
                      defaultModel: nextModel,
                    })
                    .then(() =>
                      qc.invalidateQueries({
                        queryKey: queries.settings.queryKey,
                      }),
                    );
                }}
              />
            )}
            {messages.length > 0 && !isThinking && (
              <button
                type="button"
                onClick={clearCurrent}
                className="shrink-0 rounded-lg px-2 py-[5px] text-[12.5px] font-medium text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
              >
                Clear
              </button>
            )}
          </div>

          {isEmpty ? (
            <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col justify-center gap-[22px] overflow-y-auto px-7 py-6">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <span className="text-[22px] font-semibold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50">
                  What do you want to know?
                </span>
                <span className="max-w-[440px] text-[13.5px] text-zinc-600 text-pretty dark:text-zinc-400">
                  The assistant can look at your repos, sessions and costs. It can't change anything.
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s.topic}
                    type="button"
                    disabled={offlineBlocked}
                    onClick={() => void handleSend(s.prompt)}
                    className="flex flex-col gap-1 rounded-xl border border-black/[0.08] bg-white px-3.5 py-3 text-left transition-colors hover:border-blue-500/40 hover:bg-[#fafcff] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:bg-blue-500/[0.06]"
                  >
                    <span className="text-[11.5px] font-semibold text-zinc-500 dark:text-zinc-400">
                      {s.topic}
                    </span>
                    <span className="text-[13.5px] text-zinc-900 text-pretty dark:text-zinc-100">
                      {s.prompt}
                    </span>
                  </button>
                ))}
              </div>
              {error && <ChatError error={error} provider={provider} />}
              {composer}
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto flex max-w-[720px] flex-col gap-5 px-7 py-6">
                  {messages.map((msg, i) => (
                    <MessageRow key={i} msg={msg} messages={messages} />
                  ))}
                  {isThinking && <Thinking />}
                  {error && <ChatError error={error} provider={provider} />}
                </div>
              </div>
              <div className="mx-auto w-full max-w-[720px] px-7 pb-5">{composer}</div>
            </>
          )}
        </div>
      </div>
    </Page>
  );
}

const SUGGESTIONS = [
  { topic: "Costs", prompt: "Which repo did I spend the most on this month?" },
  { topic: "Recap", prompt: "What did I work on yesterday?" },
  { topic: "Tools", prompt: "Show my 5 most-used tools" },
  { topic: "Health", prompt: "Which repos are missing a CLAUDE.md?" },
];

// ── Composer ───────────────────────────────────────────────────────────

function Composer({
  inputRef,
  value,
  onChange,
  onKeyDown,
  onSend,
  onStop,
  isThinking,
  offlineHint,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop: () => void;
  isThinking: boolean;
  offlineHint: string | null;
}) {
  const ready = value.trim().length > 0 && !offlineHint;
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] border border-black/[0.12] bg-white py-2 pl-3.5 pr-2.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] focus-within:border-blue-500/50 dark:border-white/[0.12] dark:bg-white/[0.04]">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask about your repos, sessions or costs…"
        rows={2}
        disabled={isThinking}
        className="block w-full resize-none bg-transparent py-0.5 text-sm leading-normal text-zinc-900 placeholder:text-zinc-400 focus:outline-none disabled:opacity-60 dark:text-zinc-100"
      />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11.5px] text-zinc-400">
          {offlineHint ?? "Enter to send · Shift + Enter for a new line"}
        </span>
        {isThinking ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="flex size-[30px] items-center justify-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
          >
            <Square className="size-3 fill-current" strokeWidth={0} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!ready}
            aria-label="Send"
            title={offlineHint ?? "Send"}
            className={cn(
              "flex size-[30px] items-center justify-center rounded-lg text-white transition-colors",
              ready ? "bg-blue-600 hover:bg-blue-500" : "bg-zinc-300 dark:bg-zinc-700",
            )}
          >
            <ArrowUp size={15} strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}

function ChatError({ error, provider }: { error: string; provider: AssistantProvider }) {
  const toSettings = () => {
    window.location.hash = "/settings?tab=assistant";
  };
  if (/\b401\b|invalid.{0,12}(api.?key|x-api-key)|authentication/i.test(error)) {
    return (
      <ErrorState
        title={`${PROVIDER_LABELS[provider]} didn't accept your API key`}
        body="The key may have been revoked or mistyped. Add a new one in Settings › Assistant."
        action={{ label: "Update key", onClick: toSettings }}
        error={error}
      />
    );
  }
  return <ErrorState title="Couldn't get an answer" body={error} />;
}

// ── Conversations panel ────────────────────────────────────────────────

function groupConversations(conversations: Conversation[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  const y0 = t0 - 86_400_000;
  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const c of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    groups[c.updatedAt >= t0 ? 0 : c.updatedAt >= y0 ? 1 : 2].items.push(c);
  }
  return groups.filter((g) => g.items.length > 0);
}

function ConversationsPanel({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  onRename,
}: {
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const startRename = (c: Conversation) => {
    setRenamingId(c.id);
    setRenameDraft(c.title);
  };
  const commitRename = () => {
    if (renamingId) onRename(renamingId, renameDraft);
    setRenamingId(null);
  };
  const askDelete = async (c: Conversation) => {
    const ok = await confirm({
      title: "Delete this chat?",
      body: `“${c.title || "Untitled"}” and its messages will be removed from this Mac.`,
      confirmLabel: "Delete chat",
      destructive: true,
    });
    if (ok) onDelete(c.id);
  };

  return (
    <aside className="flex w-[250px] shrink-0 flex-col gap-2 border-r border-black/[0.06] bg-[#fafafa] px-2.5 py-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <button
        type="button"
        onClick={onNew}
        className="flex items-center justify-center gap-1.5 rounded-[9px] border border-black/10 bg-white px-2.5 py-[7px] text-[13px] font-medium text-zinc-900 hover:bg-zinc-100 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-zinc-100 dark:hover:bg-white/[0.1]"
      >
        <Plus size={14} strokeWidth={2} />
        New chat
      </button>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none]">
        {groups.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
            Your chats will show up here.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="flex flex-col gap-px">
              <span className="px-2.5 pb-1 pt-2.5 text-[11.5px] font-semibold text-zinc-500 dark:text-zinc-400">
                {g.label}
              </span>
              {g.items.map((c) =>
                renamingId === c.id ? (
                  <input
                    key={c.id}
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenamingId(null);
                      }
                    }}
                    className="rounded-lg border border-blue-500/50 bg-white px-2.5 py-1.5 text-[13px] text-zinc-900 focus:outline-none dark:bg-zinc-900 dark:text-zinc-100"
                  />
                ) : (
                  <div
                    key={c.id}
                    className={cn(
                      "group flex items-center rounded-lg transition-colors",
                      c.id === currentId
                        ? "bg-black/[0.06] dark:bg-white/[0.08]"
                        : "hover:bg-black/[0.05] dark:hover:bg-white/[0.05]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      onDoubleClick={() => startRename(c)}
                      className="min-w-0 flex-1 truncate px-2.5 py-[7px] text-left text-[13px] text-zinc-800 dark:text-zinc-200"
                    >
                      {c.title || "Untitled"}
                    </button>
                    <span className="hidden shrink-0 items-center pr-1 group-hover:flex">
                      <button
                        type="button"
                        onClick={() => startRename(c)}
                        title="Rename"
                        aria-label="Rename"
                        className="rounded p-1 text-zinc-500 hover:bg-black/[0.06] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/[0.08] dark:hover:text-zinc-100"
                      >
                        <Pencil className="size-3" strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void askDelete(c)}
                        title="Delete"
                        aria-label="Delete"
                        className="rounded p-1 text-zinc-500 hover:bg-rose-500/10 hover:text-rose-700 dark:text-zinc-400 dark:hover:text-rose-300"
                      >
                        <Trash2 className="size-3" strokeWidth={2} />
                      </button>
                    </span>
                  </div>
                ),
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// ── States ─────────────────────────────────────────────────────────────

function ApiKeyMissing() {
  const qc = useQueryClient();
  const settings = useQuery(queries.settings);
  const update = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: queries.settings.queryKey }),
  });
  const useOllama = () => {
    if (!settings.data) return;
    update.mutate({
      ...settings.data,
      provider: "ollama",
      defaultModel: DEFAULT_MODEL_FOR.ollama,
    });
  };
  return (
    <Page>
      <PageHeader title="Assistant" lead="Ask questions about your repos, sessions and costs." />
      <EmptyState
        icon={KeyRound}
        title="Add an API key to start chatting"
        body="The assistant needs a key from Anthropic, OpenAI, Gemini or xAI. Or run Ollama on this Mac and no key is needed."
        primary={{
          label: "Add a key",
          onClick: () => {
            window.location.hash = "/settings?tab=assistant";
          },
        }}
        secondary={{ label: "Use Ollama", onClick: useOllama }}
      />
    </Page>
  );
}

function AssistantSkeleton() {
  return (
    <Page className="h-full min-h-[560px] pb-6">
      <div className="flex flex-col gap-2">
        <Bone className="h-7 w-32 rounded-lg" />
        <Bone className="h-4 w-80 rounded-md" />
      </div>
      <PageLoading caption="Opening your chats…">
        <div className="flex h-[520px] gap-3">
          <Bone className="w-[250px]" />
          <Bone className="flex-1" />
        </div>
      </PageLoading>
    </Page>
  );
}

function Thinking() {
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      <LiveDot tone="blue" />
      <span className="animate-pulse-soft">Thinking…</span>
    </div>
  );
}

// ── Messages ───────────────────────────────────────────────────────────

function MessageRow({
  msg,
  messages,
}: {
  msg: ChatMessage;
  messages: ChatMessage[];
}) {
  if (msg.role === "user" && typeof msg.content === "string") {
    return (
      <div className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-[16px_16px_4px_16px] bg-blue-600 px-3.5 py-[9px] text-sm leading-normal text-white">
        {msg.content}
      </div>
    );
  }

  // Tool results render inside the chip of the call they answer.
  if (msg.role === "user") return null;

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    return (
      <div className="flex flex-col gap-3">
        {msg.content.map((block, i) => {
          if (block.type === "text") return <Markdown key={i}>{block.text}</Markdown>;
          if (block.type === "tool_use") {
            return <ToolChip key={i} block={block} result={findResult(messages, block.id)} />;
          }
          return null;
        })}
      </div>
    );
  }

  return null;
}

/** Plain-English labels for the assistant's read-only tools. */
const TOOL_LABELS: Record<string, string> = {
  list_repos: "Looked at your repos",
  session_stats: "Checked your session stats",
  cost_breakdown: "Checked your costs",
  hygiene_issues: "Checked your repos for problems",
  active_processes: "Checked what's running",
  recent_sessions: "Looked at your recent sessions",
  tool_usage: "Checked which tools agents used",
};

/** Collapsed "✓ Checked your costs ›" chip; expands to the raw call and result. */
function ToolChip({ block, result }: { block: ToolUseBlock; result: ToolResultBlock | null }) {
  const [open, setOpen] = useState(false);
  const label = TOOL_LABELS[block.name] ?? `Used ${block.name}`;
  const args = Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : "";
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-[7px] self-start rounded-full bg-black/[0.04] py-1 pl-2 pr-2.5 text-xs text-zinc-600 transition-colors hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-zinc-300 dark:hover:bg-white/[0.1]"
      >
        {!result ? (
          <LiveDot tone="blue" />
        ) : result.is_error ? (
          <TriangleAlert size={12} strokeWidth={2.25} className="text-rose-600 dark:text-rose-400" />
        ) : (
          <Check size={12} strokeWidth={2.5} className="text-emerald-500" />
        )}
        {result?.is_error ? `Couldn't finish: ${label.toLowerCase()}` : label}
        <ChevronRight
          size={11}
          strokeWidth={2.25}
          className={cn("transition-transform duration-150", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 rounded-[10px] bg-black/[0.03] px-3 py-2.5 font-mono text-xs text-zinc-600 dark:bg-white/[0.04] dark:text-zinc-300">
          <span>
            {block.name}({args})
          </span>
          {result && (
            <pre
              className={cn(
                "max-h-72 overflow-auto whitespace-pre-wrap break-words",
                result.is_error && "text-rose-700 dark:text-rose-300",
              )}
            >
              {result.content}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function findResult(messages: ChatMessage[], toolUseId: string): ToolResultBlock | null {
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const block of m.content as ContentBlock[]) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) return block;
    }
  }
  return null;
}
