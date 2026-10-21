import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import {
  DEFAULT_MODEL_FOR,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
} from "@/lib/providers";
import {
  DEFAULT_OLLAMA_ENDPOINT,
  listOllamaModels,
  normalizeEndpoint,
  type OllamaModel,
} from "@/lib/providers/ollama";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { tokens } from "@/lib/tokens";
import { cn } from "@/lib/utils";
import type { AssistantProvider, Settings } from "@/types/api";

interface ModelPickerProps {
  settings: Settings;
  onPick: (provider: AssistantProvider, model: string) => void;
}

/** Brand-ish tint for each provider's mark (Claude amber, OpenAI emerald). */
const PROVIDER_TINT: Record<AssistantProvider, string> = {
  anthropic: "text-amber-600 dark:text-amber-400",
  openai: "text-emerald-600 dark:text-emerald-400",
  gemini: "text-sky-600 dark:text-sky-400",
  xai: "text-zinc-700 dark:text-zinc-300",
  ollama: "text-zinc-700 dark:text-zinc-300",
};

const PROVIDER_ORDER: AssistantProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "xai",
  "ollama",
];

/**
 * Combined provider+model dropdown shown in the assistant header. Lets the
 * user swap between (provider, model) without leaving the chat. Ollama
 * models are fetched live from the daemon whenever the popover opens, so
 * the list always reflects what the user has actually pulled.
 */
export function ModelPicker({ settings, onPick }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouse);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerLabel = useMemo(() => {
    const provider = settings.provider;
    if (provider === "ollama") {
      return settings.defaultModel || DEFAULT_MODEL_FOR.ollama;
    }
    const model = PROVIDER_MODELS[provider].find(
      (m) => m.id === settings.defaultModel,
    );
    return model?.label ?? settings.defaultModel;
  }, [settings.provider, settings.defaultModel]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-[5px] text-[12.5px] font-medium transition-colors",
          "border-black/[0.09] bg-white text-zinc-700 hover:bg-zinc-100",
          "dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-zinc-200 dark:hover:bg-white/[0.1]",
          open && "border-blue-500/40",
        )}
      >
        <ProviderIcon
          provider={settings.provider}
          size={12}
          className={PROVIDER_TINT[settings.provider]}
        />
        <span className="max-w-[12rem] truncate">{triggerLabel}</span>
        <ChevronDown
          size={12}
          strokeWidth={2.25}
          className={cn(
            "shrink-0 text-zinc-500 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute right-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-xl border shadow-lg",
            tokens.border.default,
            "bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md",
          )}
        >
          <ul className="max-h-96 overflow-y-auto p-1">
            {PROVIDER_ORDER.map((id) => (
              <ProviderGroup
                key={id}
                provider={id}
                settings={settings}
                onPick={(model) => {
                  onPick(id, model);
                  setOpen(false);
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ProviderGroup({
  provider,
  settings,
  onPick,
}: {
  provider: AssistantProvider;
  settings: Settings;
  onPick: (model: string) => void;
}) {
  const isOllama = provider === "ollama";
  const credential = isOllama
    ? normalizeEndpoint(settings.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT)
    : settings.apiKeys[provider];
  const hasCredential = isOllama ? true : Boolean(credential);

  return (
    <li className="mb-1 last:mb-0">
      <div className="flex items-center gap-2 px-2 pb-1 pt-2">
        <ProviderIcon provider={provider} size={11} className={PROVIDER_TINT[provider]} />
        <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">
          {PROVIDER_LABELS[provider]}
        </span>
        {!hasCredential && !isOllama && (
          <span className="ml-auto text-[11.5px] text-zinc-400">Add a key in Settings</span>
        )}
      </div>
      {isOllama ? (
        <OllamaOptions settings={settings} onPick={onPick} />
      ) : (
        PROVIDER_MODELS[provider].map((m) => (
          <ModelOption
            key={m.id}
            label={m.label}
            sublabel={m.id}
            active={
              settings.provider === provider && settings.defaultModel === m.id
            }
            disabled={!hasCredential}
            onClick={() => onPick(m.id)}
          />
        ))
      )}
    </li>
  );
}

function OllamaOptions({
  settings,
  onPick,
}: {
  settings: Settings;
  onPick: (model: string) => void;
}) {
  const endpoint = normalizeEndpoint(
    settings.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT,
  );

  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; models: OllamaModel[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  const refresh = () => {
    setState({ kind: "loading" });
    const ctrl = new AbortController();
    listOllamaModels(endpoint, ctrl.signal)
      .then((models) => setState({ kind: "ok", models }))
      .catch((e: unknown) =>
        setState({
          kind: "error",
          message:
            e instanceof Error
              ? e.message
              : "Couldn't reach Ollama at " + endpoint,
        }),
      );
    return () => ctrl.abort();
  };

  useEffect(() => {
    return refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  if (state.kind === "loading") {
    return (
      <div className="px-2 py-2 text-xs text-zinc-400 dark:text-zinc-400">
        Loading models…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="space-y-1.5 px-2 py-2">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Ollama isn't reachable. Start it with{" "}
          <span className="font-mono">ollama serve</span>.
        </p>
        <button
          type="button"
          onClick={() => refresh()}
          className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 dark:text-blue-400 hover:underline"
        >
          <RefreshCw size={10} strokeWidth={2} />
          Retry
        </button>
      </div>
    );
  }

  if (state.models.length === 0) {
    return (
      <div className="px-2 py-2 text-xs text-zinc-500 dark:text-zinc-400">
        No models pulled yet. Try{" "}
        <span className="font-mono">ollama pull llama3.2</span>.
      </div>
    );
  }

  return (
    <>
      {state.models.map((m) => (
        <ModelOption
          key={m.name}
          label={m.name}
          sublabel={[m.family, m.paramSize].filter(Boolean).join(" · ") || null}
          active={
            settings.provider === "ollama" && settings.defaultModel === m.name
          }
          disabled={false}
          onClick={() => onPick(m.name)}
        />
      ))}
    </>
  );
}

function ModelOption({
  label,
  sublabel,
  active,
  disabled,
  onClick,
}: {
  label: string;
  sublabel: string | null;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        active
          ? "bg-blue-500/10 text-zinc-900 dark:text-zinc-100"
          : "text-zinc-700 dark:text-zinc-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      <Check
        size={11}
        strokeWidth={2.5}
        className={cn(
          "shrink-0 text-blue-700 dark:text-blue-300",
          !active && "invisible",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">
        {label}
      </span>
      {sublabel && (
        <span className="shrink-0 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-400">
          {sublabel}
        </span>
      )}
    </button>
  );
}
