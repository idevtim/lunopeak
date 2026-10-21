import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useHashRoute } from "@/hooks/useHashRoute";
import {
  Bell,
  Bot,
  Bug,
  Code2,
  Coffee,
  FileText,
  Globe,
  Github,
  Heart,
  HelpCircle,
  Info,
  Lightbulb,
  Eye,
  EyeOff,
  MonitorUp,
  Palette,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import {
  DEFAULT_MODEL_FOR,
  KEY_PLACEHOLDERS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
} from "@/lib/providers";
import {
  DEFAULT_OLLAMA_ENDPOINT,
  listOllamaModels,
  normalizeEndpoint,
  pingOllama,
  type OllamaModel,
} from "@/lib/providers/ollama";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useInstalledAgents } from "@/hooks/useInstalledAgents";
import { trayNoun, usePlatform, type Platform } from "@/hooks/usePlatform";
import { Page, PageHeader } from "@/components/ui/Page";
import { Bone, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { ProviderIcon } from "@/components/ui/ProviderIcon";
import { cn, openExternal } from "@/lib/utils";
import { filterEditorsForPlatform } from "@/lib/editors";
import { checkForUpdates, RELEASES_URL } from "@/lib/updates";
import { toast } from "@/stores/toastStore";
import { useUpdateStore } from "@/stores/updateStore";
import { sections } from "@/routes";
import type {
  AssistantProvider,
  Settings,
  SidebarPlanUsage,
  TrayHeadlineWindow,
  TrayPinnedProvider,
  TrayTitleStyle,
} from "@/types/api";
import { SidebarCustomizer } from "./SidebarCustomizer";
import { TerminalCards } from "./TerminalCards";
import {
  IconTile,
  LinkRow,
  OptionSet,
  PercentSlider,
  SettingBlock,
  SettingRow,
  SettingsSection,
  fieldClass,
  useSettingsSearch,
} from "./primitives";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const REPO_URL = "https://github.com/idevtim/lunopeak";

/** Patch the latest settings and save — no Save button anywhere on the page. */
type Update = (patch: (s: Settings) => Settings) => void;

function useAppVersion(): string {
  const [version, setVersion] = useState<string>(isTauri() ? "…" : "dev");
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion()
        .then((v) => {
          if (!cancelled) setVersion(v);
        })
        .catch(() => {
          if (!cancelled) setVersion("?");
        }),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}

/** Capitalized "Menu bar" / "System tray". */
const trayTitle = (platform: Platform) => {
  const noun = trayNoun(platform);
  return noun[0].toUpperCase() + noun.slice(1);
};

type CategoryId =
  | "general"
  | "agents"
  | "menubar"
  | "alerts"
  | "appearance"
  | "editors"
  | "assistant"
  | "about";

const buildCategories = (
  platform: Platform,
): ReadonlyArray<{ id: CategoryId; label: string; icon: LucideIcon }> => [
  { id: "general", label: "General", icon: SettingsIcon },
  { id: "agents", label: "Agents & projects", icon: Bot },
  { id: "menubar", label: trayTitle(platform), icon: MonitorUp },
  { id: "alerts", label: "Alerts & budget", icon: Bell },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "editors", label: "Editors & terminal", icon: Code2 },
  { id: "assistant", label: "Assistant", icon: Sparkles },
  { id: "about", label: "Help & about", icon: Info },
];

const CATEGORY_IDS = new Set<string>(buildCategories("macos").map((c) => c.id));

// Old tab ids from before the redesign — still honored for shared links.
const LEGACY_TABS: Record<string, CategoryId> = {
  workspace: "general",
  budget: "alerts",
  terminal: "editors",
};

const resolveTabParam = (v: string | null): CategoryId | null => {
  if (!v) return null;
  if (v in LEGACY_TABS) return LEGACY_TABS[v];
  return CATEGORY_IDS.has(v) ? (v as CategoryId) : null;
};

export function SettingsView() {
  const qc = useQueryClient();
  const settings = useQuery(queries.settings);
  const platform = usePlatform();
  const categories = buildCategories(platform);
  const { params } = useHashRoute();
  const paramTab = params.get("tab");
  const [tab, setTab] = useState<CategoryId>(() => resolveTabParam(paramTab) ?? "general");
  const query = useSettingsSearch((s) => s.query);
  const setQuery = useSettingsSearch((s) => s.setQuery);
  const searching = query.trim().length > 0;

  // Sync the category when the deep-link param changes (palette, other views).
  useEffect(() => {
    const resolved = resolveTabParam(paramTab);
    if (resolved) {
      setTab(resolved);
      setQuery("");
    }
  }, [paramTab, setQuery]);

  // The search query outlives the view in its store; start fresh next visit.
  useEffect(() => () => setQuery(""), [setQuery]);

  const mutation = useMutation({
    mutationFn: api.updateSettings,
    // Apply the change to the cache before the IPC round-trip so toggles
    // (especially the theme switcher) feel instant. Roll back on error.
    onMutate: async (next: Settings) => {
      await qc.cancelQueries({ queryKey: queries.settings.queryKey });
      const prev = qc.getQueryData<Settings>(queries.settings.queryKey);
      qc.setQueryData(queries.settings.queryKey, next);
      return { prev };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.prev !== undefined) {
        qc.setQueryData(queries.settings.queryKey, ctx.prev);
      }
      toast.error("Couldn't save that setting", err instanceof Error ? err.message : String(err));
    },
    onSettled: (_data, _err, next, ctx) => {
      qc.invalidateQueries({ queryKey: queries.settings.queryKey });
      qc.invalidateQueries({ queryKey: queries.repos.queryKey });

      const prevAgents = ctx?.prev?.agents;
      const nextAgents = next.agents;
      const agentsChanged =
        prevAgents == null ||
        prevAgents.claudeCode !== nextAgents.claudeCode ||
        prevAgents.codex !== nextAgents.codex ||
        prevAgents.cursor !== nextAgents.cursor ||
        prevAgents.cursorWeb !== nextAgents.cursorWeb;

      if (agentsChanged) {
        // Toggling an agent fundamentally changes which data sources feed
        // sessions / costs / activity / usage. The QueryClient runs with
        // `refetchOnMount: false` (see main.tsx), so plain `invalidateQueries`
        // won't refetch when the dashboard remounts — it just hands back the
        // stale cached payload. Wiping the entries forces the next mount to
        // fetch fresh.
        const agentDerivedKeys: ReadonlyArray<readonly unknown[]> = [
          queries.dashboardSummary.queryKey,
          queries.sessions.queryKey,
          queries.sessionStats.queryKey,
          queries.costs.queryKey,
          queries.activeProcesses.queryKey,
          queries.liveActivity.queryKey,
          queries.usageLimits.queryKey,
          ["tool-stats"],
        ];
        for (const queryKey of agentDerivedKeys) {
          qc.removeQueries({ queryKey });
        }
      } else {
        qc.invalidateQueries({ queryKey: queries.dashboardSummary.queryKey });
      }
    },
  });

  // Read the cache, not the render snapshot, so back-to-back changes compose.
  const update: Update = (patch) => {
    const current = qc.getQueryData<Settings>(queries.settings.queryKey) ?? settings.data;
    if (current) mutation.mutate(patch(current));
  };

  // While searching every category renders; the nav lists only those with
  // a visible row (rows hide themselves, so read it back from the DOM).
  const contentRef = useRef<HTMLDivElement>(null);
  const [matched, setMatched] = useState<Set<string> | null>(null);
  // Recompute after every render, and when a category's own data lands
  // (those re-render below this component, so watch the DOM too).
  const recompute = () => {
    const el = contentRef.current;
    let next: Set<string> | null = null;
    if (useSettingsSearch.getState().query.trim() && el) {
      next = new Set<string>();
      el.querySelectorAll<HTMLElement>("[data-category]").forEach((c) => {
        if (c.querySelector("[data-setting-row]")) next!.add(c.dataset.category!);
      });
    }
    const key = (v: Set<string> | null) => (v ? [...v].join(",") : "-");
    setMatched((prev) => (key(prev) === key(next) ? prev : next));
  };
  useLayoutEffect(recompute);
  useEffect(() => {
    const el = contentRef.current;
    if (!searching || !el) return;
    const observer = new MutationObserver(recompute);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  const showSkeleton = useDelayedLoading(settings.isLoading);

  const header = (
    <PageHeader
      title="Settings"
      lead="Changes save as you make them."
      actions={
        <label className={cn(fieldClass, "w-60 py-[5px] text-[12.5px]")}>
          <Search size={13} strokeWidth={2} className="shrink-0 text-zinc-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            className="min-w-0 flex-1 bg-transparent text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
          />
        </label>
      }
    />
  );

  if (!settings.data) {
    return (
      <Page>
        {header}
        {settings.isError ? (
          <ErrorState
            title="Couldn't load your settings"
            body="LunoPeak couldn't read its settings file. Your choices are still on disk."
            onRetry={() => void settings.refetch()}
            error={settings.error}
          />
        ) : (
          showSkeleton && <SettingsSkeleton />
        )}
      </Page>
    );
  }

  const s = settings.data;
  const visible = searching ? categories : categories.filter((c) => c.id === tab);

  return (
    <Page>
      {header}
      <div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-7">
        <nav aria-label="Settings categories" className="sticky top-0 flex flex-col gap-0.5">
          {categories.map(({ id, label, icon: Icon }) => {
            if (matched && !matched.has(id)) return null;
            const active = !searching && tab === id;
            return (
              <button
                key={id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  setQuery("");
                  setTab(id);
                }}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[13px] transition-colors",
                  active
                    ? "bg-black/[0.07] font-medium text-zinc-900 dark:bg-white/[0.08] dark:text-zinc-50"
                    : "text-zinc-700 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.05]",
                )}
              >
                <Icon
                  size={15}
                  strokeWidth={1.75}
                  className={active ? "text-blue-600 dark:text-blue-400" : "text-zinc-500 dark:text-zinc-400"}
                />
                {label}
              </button>
            );
          })}
        </nav>

        <div ref={contentRef} className="flex min-w-0 flex-col gap-8">
          {matched?.size === 0 && (
            <p className="m-0 px-0.5 text-[13px] text-zinc-500 dark:text-zinc-400">
              No settings match “{query.trim()}”.
            </p>
          )}
          {visible.map((c) => (
            <div
              key={c.id}
              data-category={c.id}
              className="flex flex-col gap-5 [&:not(:has([data-setting-row]))]:hidden"
            >
              <h2 className="m-0 text-lg font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">
                {c.label}
              </h2>
              <CategoryContent id={c.id} s={s} update={update} platform={platform} />
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}

function CategoryContent({
  id,
  s,
  update,
  platform,
}: {
  id: CategoryId;
  s: Settings;
  update: Update;
  platform: Platform;
}) {
  switch (id) {
    case "general":
      return <GeneralCategory s={s} update={update} platform={platform} />;
    case "agents":
      return <AgentsCategory s={s} update={update} platform={platform} />;
    case "menubar":
      return <MenuBarCategory s={s} update={update} platform={platform} />;
    case "alerts":
      return <AlertsCategory s={s} update={update} />;
    case "appearance":
      return <AppearanceCategory s={s} update={update} />;
    case "editors":
      return <EditorsCategory s={s} update={update} />;
    case "assistant":
      return <AssistantCategory s={s} update={update} platform={platform} />;
    case "about":
      return <AboutCategory s={s} platform={platform} />;
  }
}

function SettingsSkeleton() {
  return (
    <PageLoading caption="Loading your settings…">
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-7">
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 8 }, (_, i) => (
            <Bone key={i} className="h-8 rounded-lg" />
          ))}
        </div>
        <div className="flex flex-col gap-5">
          <Bone className="h-6 w-40 rounded-md" />
          <Bone className="h-28 rounded-xl" />
          <Bone className="h-40 rounded-xl" />
          <Bone className="h-20 rounded-xl" />
        </div>
      </div>
    </PageLoading>
  );
}

// ─── Updates ──────────────────────────────────────────────────────────────

function formatCheckedAt(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `today at ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

/** Shared by General › Updates and the Help & about version card. */
function useUpdateCheck(autoCheck: boolean) {
  const available = useUpdateStore((st) => st.update);
  const checkedAt = useUpdateStore((st) => st.checkedAt);
  const [checking, setChecking] = useState(false);
  const [justChecked, setJustChecked] = useState(false);

  const check = async () => {
    if (!isTauri()) {
      toast.info("Updates aren't available in browser mode");
      return;
    }
    setChecking(true);
    const before = useUpdateStore.getState().checkedAt;
    await checkForUpdates({ quiet: true });
    setChecking(false);
    if (useUpdateStore.getState().checkedAt === before) {
      toast.error("Couldn't check for updates", "LunoPeak couldn't reach GitHub. Try again in a minute.");
      return;
    }
    setJustChecked(true);
  };

  let text: string;
  let tone: "muted" | "green" | "blue" = "muted";
  if (checking) text = "Checking…";
  else if (available) {
    text = `Version ${available.version} is ready to install`;
    tone = "blue";
  } else if (justChecked) {
    text = "You're up to date";
    tone = "green";
  } else if (checkedAt) text = `Last checked ${formatCheckedAt(checkedAt)}`;
  else text = autoCheck ? "Checks automatically while LunoPeak is open" : "Automatic checks are off";

  const toneClass = {
    muted: "text-zinc-500 dark:text-zinc-400",
    green: "text-emerald-700 dark:text-emerald-400",
    blue: "text-blue-700 dark:text-blue-400",
  }[tone];

  return { text, toneClass, checking, check };
}

// ─── General ──────────────────────────────────────────────────────────────

function GeneralCategory({ s, update, platform }: { s: Settings; update: Update; platform: Platform }) {
  const updates = useUpdateCheck(s.general.checkUpdates);

  const setLaunchAtLogin = async (v: boolean) => {
    update((cur) => ({ ...cur, general: { ...cur.general, launchAtLogin: v } }));
    if (!isTauri()) return;
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (v) await enable();
      else await disable();
    } catch (e) {
      toast.error("Couldn't change open at login", e instanceof Error ? e.message : String(e));
      // Revert the toggle if the OS rejected it.
      update((cur) => ({ ...cur, general: { ...cur.general, launchAtLogin: !v } }));
    }
  };

  return (
    <>
      <SettingsSection title="Startup">
        <SettingRow
          label="Open LunoPeak at login"
          keywords="launch startup autostart"
          control={
            <Switch
              checked={s.general.launchAtLogin}
              onChange={(v) => void setLaunchAtLogin(v)}
              ariaLabel="Open at login"
            />
          }
        />
        <SettingRow
          label="Keep running when the window closes"
          hint={
            s.tray.enabled
              ? `The ${trayNoun(platform)} keeps showing usage.`
              : `Needs LunoPeak in the ${trayNoun(platform)}. Turn that on under ${trayTitle(platform)}.`
          }
          keywords="close to tray quit hide"
          dimmed={!s.tray.enabled}
          control={
            <Switch
              checked={s.tray.closeToTray}
              disabled={!s.tray.enabled}
              onChange={(v) => update((cur) => ({ ...cur, tray: { ...cur.tray, closeToTray: v } }))}
              ariaLabel="Keep running"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Updates">
        <SettingRow
          label="Check for updates automatically"
          control={
            <Switch
              checked={s.general.checkUpdates}
              onChange={(v) =>
                update((cur) => ({
                  ...cur,
                  general: {
                    ...cur.general,
                    checkUpdates: v,
                    // Auto-install only makes sense when checking is on.
                    autoInstallUpdates: v ? cur.general.autoInstallUpdates : false,
                  },
                }))
              }
              ariaLabel="Check for updates automatically"
            />
          }
        />
        <SettingRow
          label="Install updates automatically"
          hint="Downloads in the background and installs on next launch."
          dimmed={!s.general.checkUpdates}
          control={
            <Switch
              checked={s.general.autoInstallUpdates}
              disabled={!s.general.checkUpdates}
              onChange={(v) =>
                update((cur) => ({ ...cur, general: { ...cur.general, autoInstallUpdates: v } }))
              }
              ariaLabel="Install updates automatically"
            />
          }
        />
        <SettingRow
          label={<span className={updates.toneClass}>{updates.text}</span>}
          keywords="check for updates now version"
          control={
            <Button onClick={() => void updates.check()} disabled={updates.checking}>
              Check now
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Scrolling">
        <SettingRow
          label="Always show scrollbars"
          hint="Otherwise they stay hidden."
          control={
            <Switch
              checked={s.general.showScrollbars}
              onChange={(v) =>
                update((cur) => ({ ...cur, general: { ...cur.general, showScrollbars: v } }))
              }
              ariaLabel="Always show scrollbars"
            />
          }
        />
      </SettingsSection>
    </>
  );
}

// ─── Agents & projects ────────────────────────────────────────────────────

function AgentsCategory({ s, update, platform }: { s: Settings; update: Update; platform: Platform }) {
  const [home, setHome] = useState<string>("");
  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/path").then(({ homeDir }) =>
      homeDir().then(setHome).catch(() => undefined),
    );
  }, []);

  // Only offer Cursor as a data source when it's actually installed. Optimistic
  // while the probe is loading (undefined) — only hidden once we know it's absent.
  const installed = useInstalledAgents();
  const showCursor = installed?.cursor !== false;
  const dir = (name: string) => (home ? `${home.replace(/\/$/, "")}/${name}` : `~/${name}`);

  const setAgent = (key: keyof Settings["agents"], v: boolean) =>
    update((cur) => ({ ...cur, agents: { ...cur.agents, [key]: v } }));

  const agent = (key: "claudeCode" | "codex" | "cursor", name: string, provider: string, path: string) => (
    <SettingRow
      label={name}
      hint={<span className="font-mono text-[11.5px]">{path}</span>}
      keywords={`${name} ${path} agent track`}
      leading={<ProviderIcon provider={provider} size={16} className="shrink-0 text-zinc-500 dark:text-zinc-400" />}
      control={<Switch checked={s.agents[key]} onChange={(v) => setAgent(key, v)} ariaLabel={`Track ${name}`} />}
    />
  );

  const addFolder = async () => {
    if (!isTauri()) {
      toast.info("Adding folders needs the desktop app");
      return;
    }
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      update((cur) =>
        cur.scanDirs.includes(selected) ? cur : { ...cur, scanDirs: [...cur.scanDirs, selected] },
      );
    }
  };
  const removeFolder = (path: string) => {
    const index = s.scanDirs.indexOf(path);
    update((cur) => ({ ...cur, scanDirs: cur.scanDirs.filter((d) => d !== path) }));
    toast.success("Folder removed", path, {
      action: {
        label: "Undo",
        onClick: () =>
          update((cur) => {
            if (cur.scanDirs.includes(path)) return cur;
            const next = [...cur.scanDirs];
            next.splice(Math.min(index, next.length), 0, path);
            return { ...cur, scanDirs: next };
          }),
      },
    });
  };

  return (
    <>
      <SettingsSection
        title="Agents to track"
        caption={`Turned-off agents disappear from the dashboard, sidebar and ${trayNoun(platform)}.`}
      >
        {agent("claudeCode", "Claude Code", "claude", dir(".claude"))}
        {agent("codex", "Codex", "codex", dir(".codex"))}
        {showCursor && agent("cursor", "Cursor", "cursor", dir(".cursor"))}
        {showCursor && (
          <SettingRow
            className="pl-12"
            label="Read plan usage from cursor.com"
            hint={
              platform === "macos"
                ? "Uses your browser sign-in. macOS asks for Keychain access the first time."
                : "Uses your browser sign-in."
            }
            keywords="cursor web plan usage on-demand spend"
            dimmed={!s.agents.cursor}
            control={
              <Switch
                checked={s.agents.cursorWeb}
                disabled={!s.agents.cursor}
                onChange={(v) => setAgent("cursorWeb", v)}
                ariaLabel="Read plan usage from cursor.com"
              />
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title="Project folders" caption="LunoPeak looks for git repos inside these folders.">
        {s.scanDirs.length === 0 ? (
          <SettingBlock keywords="project folders scan directories repos">
            <p className="m-0 text-[13px] text-zinc-500 dark:text-zinc-400">
              No folders yet. Add one to start finding repos.
            </p>
          </SettingBlock>
        ) : (
          s.scanDirs.map((path) => (
            <SettingRow
              key={path}
              label={<span className="font-mono text-[12.5px]">{path}</span>}
              keywords={`${path} project folder scan directory`}
              control={
                <Button variant="ghost" onClick={() => removeFolder(path)}>
                  Remove
                </Button>
              }
            />
          ))
        )}
        <SettingBlock keywords="add project folder scan directory repos" className="py-2.5">
          <Button onClick={() => void addFolder()}>Add folder…</Button>
        </SettingBlock>
      </SettingsSection>
    </>
  );
}

// ─── Menu bar (system tray) ───────────────────────────────────────────────

const TRAY_PROVIDER_OPTIONS: ReadonlyArray<{ id: TrayPinnedProvider; label: string }> = [
  { id: "auto", label: "Highest" },
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
];

const TRAY_WINDOW_OPTIONS: ReadonlyArray<{ id: TrayHeadlineWindow; label: string }> = [
  { id: "5h", label: "This session" },
  { id: "weekly", label: "This week" },
  { id: "fable", label: "Fable" },
];

/** Short window name the tray appends, mirroring `tray::headline_windows`. */
const TRAY_WINDOW_SHORT: Record<TrayHeadlineWindow, string> = {
  "5h": "5h",
  weekly: "Wk",
  fable: "Fable",
};

function MenuBarCategory({ s, update, platform }: { s: Settings; update: Update; platform: Platform }) {
  const t = s.tray;
  const setTray = (patch: Partial<Settings["tray"]>) =>
    update((cur) => ({ ...cur, tray: { ...cur.tray, ...patch } }));
  const titleOptions: ReadonlyArray<{ id: TrayTitleStyle; label: string }> = [
    { id: "off", label: "Icon only" },
    { id: "percent", label: "72%" },
    { id: "percentWindow", label: `72% ${TRAY_WINDOW_SHORT[t.headlineWindow]}` },
  ];

  return (
    <>
      <SettingsSection title={trayTitle(platform)}>
        <SettingRow
          label={`Show LunoPeak in the ${trayNoun(platform)}`}
          hint="A status icon with live usage and quick navigation."
          keywords="tray status icon"
          control={
            <Switch checked={t.enabled} onChange={(v) => setTray({ enabled: v })} ariaLabel="Show in the menu bar" />
          }
        />
      </SettingsSection>

      <SettingsSection title="What it shows" caption={`You can change these from the ${trayNoun(platform)} panel too.`}>
        {/* Windows draws no text beside tray icons; its tooltip already
            names each provider and window. */}
        {platform !== "windows" && (
          <SettingRow
            label="Show"
            hint="What appears beside the LunoPeak icon."
            keywords="menu bar text title percent icon only"
            dimmed={!t.enabled}
            below={
              <OptionSet
                value={t.titleStyle}
                options={titleOptions}
                onChange={(v) => setTray({ titleStyle: v })}
                ariaLabel="Menu bar text"
              />
            }
          />
        )}
        <SettingRow
          label="Percent for"
          hint="“Highest” follows whichever agent is closest to its limit."
          keywords="headline provider pinned"
          dimmed={!t.enabled}
          below={
            <OptionSet
              value={t.pinnedProvider}
              options={TRAY_PROVIDER_OPTIONS}
              onChange={(v) => setTray({ pinnedProvider: v })}
              ariaLabel="Percent for"
            />
          }
        />
        <SettingRow
          label="Which limit"
          hint="Fable falls back to This week when there’s no Fable limit."
          keywords="headline window 5h weekly session"
          dimmed={!t.enabled}
          below={
            <OptionSet
              value={t.headlineWindow}
              options={TRAY_WINDOW_OPTIONS}
              onChange={(v) => setTray({ headlineWindow: v })}
              ariaLabel="Which limit"
            />
          }
        />
      </SettingsSection>
    </>
  );
}

// ─── Alerts & budget ──────────────────────────────────────────────────────

function AlertsCategory({ s, update }: { s: Settings; update: Update }) {
  const alerts = s.usageAlerts;
  const budget = s.costBudget;
  const setAlerts = (patch: Partial<Settings["usageAlerts"]>) =>
    update((cur) => ({ ...cur, usageAlerts: { ...cur.usageAlerts, ...patch } }));
  const setBudget = (patch: Partial<Settings["costBudget"]>) =>
    update((cur) => ({ ...cur, costBudget: { ...cur.costBudget, ...patch } }));

  return (
    <>
      <SettingsSection title="Limit alerts" caption="Get a notification before you run out.">
        <SettingRow
          label="Warn me when a limit is nearly used"
          hint="Covers each agent’s 5-hour and weekly limits."
          keywords="usage alerts notification threshold"
          control={
            <Switch checked={alerts.enabled} onChange={(v) => setAlerts({ enabled: v })} ariaLabel="Usage alerts" />
          }
        />
        <SettingBlock keywords="warn at limit alert threshold percent">
          <PercentSlider
            value={alerts.thresholdPct}
            disabled={!alerts.enabled}
            onChange={(v) => setAlerts({ thresholdPct: v })}
          />
        </SettingBlock>
      </SettingsSection>

      <SettingsSection title="Spending budget" caption="Leave at $0 for no budget.">
        <SettingBlock keywords="spending budget cost per day daily per month monthly">
          <div className="flex flex-wrap gap-4">
            <BudgetInput label="Per day" value={budget.dailyUsd} onChange={(v) => setBudget({ dailyUsd: v })} />
            <BudgetInput label="Per month" value={budget.monthlyUsd} onChange={(v) => setBudget({ monthlyUsd: v })} />
          </div>
        </SettingBlock>
        <SettingBlock keywords="budget warn at threshold percent">
          <PercentSlider
            value={budget.alertThresholdPct}
            onChange={(v) => setBudget({ alertThresholdPct: v })}
          />
        </SettingBlock>
      </SettingsSection>
    </>
  );
}

function BudgetInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex flex-col gap-[5px]">
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className={cn(fieldClass, "w-[140px] gap-[3px]")}>
        <span className="text-zinc-500 dark:text-zinc-400">$</span>
        <input
          type="number"
          min={0}
          step="1"
          value={value}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))}
          className="min-w-0 flex-1 bg-transparent tabular-nums text-zinc-900 outline-none dark:text-zinc-100"
        />
      </span>
    </label>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────

const THEME_OPTIONS: ReadonlyArray<{ id: Settings["theme"]; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match system" },
];

const PLAN_USAGE_OPTIONS: ReadonlyArray<{ id: SidebarPlanUsage; label: string }> = [
  { id: "always", label: "Always" },
  { id: "close", label: "Only when one is close" },
  { id: "off", label: "Hide" },
];

/** Sections "Fold rarely used sections" folds: Agent setup and Backups. */
const RARE_SECTIONS = ["setup", "backups"];
const DEFAULT_FOLDED = sections.filter((x) => x.foldedByDefault).map((x) => x.id);

function AppearanceCategory({ s, update }: { s: Settings; update: Update }) {
  const [customizing, setCustomizing] = useState(false);
  const sidebar = s.sidebar ?? { planUsage: "always", foldedSections: DEFAULT_FOLDED };
  const folded = sidebar.foldedSections ?? DEFAULT_FOLDED;
  const foldRare = RARE_SECTIONS.every((id) => folded.includes(id));
  const setSidebar = (patch: (sb: Settings["sidebar"]) => Partial<Settings["sidebar"]>) =>
    update((cur) => {
      const sb = cur.sidebar ?? { planUsage: "always", foldedSections: DEFAULT_FOLDED };
      return { ...cur, sidebar: { ...sb, ...patch(sb) } };
    });
  const hiddenCount = s.hiddenSidebarItems.length;
  const customized = hiddenCount > 0 || s.sidebarOrder.length > 0;

  return (
    <>
      <SettingsSection title="Theme">
        <SettingRow
          label="Appearance"
          keywords="theme light dark system mode"
          below={
            <OptionSet
              value={s.theme}
              options={THEME_OPTIONS}
              onChange={(v) => update((cur) => ({ ...cur, theme: v }))}
              ariaLabel="Appearance"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Sidebar">
        <SettingRow
          label="Plan usage in the sidebar"
          hint="Appears above Settings on every page except Home, which already shows limits. “Only when one is close” shows the card once any agent passes 70%."
          keywords="limits card"
          below={
            <OptionSet
              value={sidebar.planUsage}
              options={PLAN_USAGE_OPTIONS}
              onChange={(v) => setSidebar(() => ({ planUsage: v }))}
              ariaLabel="Plan usage in the sidebar"
            />
          }
        />
        <SettingRow
          label="Fold rarely used sections"
          hint="Agent setup and Backups start folded."
          keywords="collapse"
          control={
            <Switch
              checked={foldRare}
              onChange={(v) =>
                setSidebar((sb) => {
                  const rest = (sb.foldedSections ?? DEFAULT_FOLDED).filter((id) => !RARE_SECTIONS.includes(id));
                  return { foldedSections: v ? [...rest, ...RARE_SECTIONS] : rest };
                })
              }
              ariaLabel="Fold rarely used sections"
            />
          }
        />
        <SettingRow
          label="Sidebar items"
          hint={
            hiddenCount > 0
              ? `Hide pages you don’t use and change their order. ${hiddenCount} hidden now.`
              : "Hide pages you don’t use and change their order."
          }
          keywords="customize reorder hide show pages"
          control={
            <>
              {customized && (
                <Button
                  variant="ghost"
                  onClick={() => update((cur) => ({ ...cur, hiddenSidebarItems: [], sidebarOrder: [] }))}
                >
                  Reset
                </Button>
              )}
              <Button onClick={() => setCustomizing(true)}>Customize…</Button>
            </>
          }
        />
      </SettingsSection>

      {/* Mounted only while open so each visit starts from the saved layout. */}
      {customizing && (
        <SidebarCustomizer
          open
          hidden={s.hiddenSidebarItems}
          order={s.sidebarOrder}
          onClose={() => setCustomizing(false)}
          onSave={(nextHidden, nextOrder) =>
            update((cur) => ({ ...cur, hiddenSidebarItems: nextHidden, sidebarOrder: nextOrder }))
          }
        />
      )}
    </>
  );
}

// ─── Editors & terminal ───────────────────────────────────────────────────

const ASK_EACH_TIME = "__ask__";

function EditorsCategory({ s, update }: { s: Settings; update: Update }) {
  const available = useQuery(queries.availableEditors);
  const editors = filterEditorsForPlatform(available.data);
  const options = [
    { id: ASK_EACH_TIME, label: "Ask each time" },
    ...editors.map((ed) => ({ id: ed.id, label: ed.label })),
  ];

  return (
    <>
      <SettingsSection title="Editor">
        <SettingRow
          label="Open files and folders in"
          hint="You can still pick another editor from any Open menu."
          keywords={`default editor ${editors.map((e) => e.label).join(" ")}`}
          below={
            <OptionSet
              value={s.editor.defaultEditor ?? ASK_EACH_TIME}
              options={options}
              onChange={(v) =>
                update((cur) => ({
                  ...cur,
                  editor: { ...cur.editor, defaultEditor: v === ASK_EACH_TIME ? null : v },
                }))
              }
              ariaLabel="Default editor"
            />
          }
        />
      </SettingsSection>
      <TerminalCards settings={s} update={update} />
    </>
  );
}

// ─── Assistant ────────────────────────────────────────────────────────────

const PROVIDER_IDS: AssistantProvider[] = ["anthropic", "openai", "gemini", "xai", "ollama"];

const PROVIDER_KEY_URLS: Record<Exclude<AssistantProvider, "ollama">, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  xai: "https://console.x.ai",
};

const keyStore = (platform: Platform) =>
  platform === "macos" ? "your Keychain" : platform === "windows" ? "Credential Manager" : "your system keyring";

function AssistantCategory({ s, update, platform }: { s: Settings; update: Update; platform: Platform }) {
  const activeId = s.provider;
  const isOllama = activeId === "ollama";
  const models = PROVIDER_MODELS[activeId];
  const activeModel = isOllama
    ? s.defaultModel || DEFAULT_MODEL_FOR.ollama
    : models.some((m) => m.id === s.defaultModel)
      ? s.defaultModel
      : DEFAULT_MODEL_FOR[activeId];

  const selectProvider = (id: AssistantProvider) =>
    update((cur) => {
      const defaultModel =
        id === "ollama"
          ? cur.defaultModel || DEFAULT_MODEL_FOR.ollama
          : PROVIDER_MODELS[id].some((m) => m.id === cur.defaultModel)
            ? cur.defaultModel
            : DEFAULT_MODEL_FOR[id];
      return { ...cur, provider: id, defaultModel };
    });
  const setModel = (model: string) => update((cur) => ({ ...cur, defaultModel: model }));

  return (
    <SettingsSection title="Assistant" caption="Chat with your dev environment from the Assistant page.">
      <SettingRow
        label="Provider"
        keywords="anthropic openai gemini xai ollama ai llm"
        below={
          <OptionSet
            value={activeId}
            options={PROVIDER_IDS.map((id) => ({
              id,
              label: (
                <>
                  <ProviderIcon provider={id} size={12} />
                  {id === "ollama" ? "Ollama (local)" : PROVIDER_LABELS[id]}
                </>
              ),
            }))}
            onChange={selectProvider}
            ariaLabel="Assistant provider"
          />
        }
      />
      {isOllama ? (
        <OllamaConfig
          endpoint={s.ollamaEndpoint || DEFAULT_OLLAMA_ENDPOINT}
          activeModel={activeModel}
          onEndpointChange={(v) =>
            update((cur) => ({ ...cur, ollamaEndpoint: v.trim() || DEFAULT_OLLAMA_ENDPOINT }))
          }
          onModelChange={setModel}
        />
      ) : (
        <>
          <SettingRow
            label="API key"
            hint={`Stored in ${keyStore(platform)}, only on this computer. Keys in your shell environment are picked up automatically.`}
            keywords="secret token"
            control={
              <Button variant="link" onClick={() => openExternal(PROVIDER_KEY_URLS[activeId])}>
                Get an API key ↗
              </Button>
            }
            below={
              <ApiKeyInput
                key={activeId}
                value={s.apiKeys[activeId] ?? ""}
                placeholder={KEY_PLACEHOLDERS[activeId]}
                onChange={(v) =>
                  update((cur) => ({ ...cur, apiKeys: { ...cur.apiKeys, [activeId]: v || null } }))
                }
              />
            }
          />
          <SettingRow
            label="Model"
            keywords={models.map((m) => m.label).join(" ")}
            below={<OptionSet value={activeModel} options={models} onChange={setModel} ariaLabel="Model" />}
          />
        </>
      )}
    </SettingsSection>
  );
}

function ApiKeyInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const [reveal, setReveal] = useState(false);
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text.trim());
    } catch {
      // clipboard read denied — silent no-op
    }
  };

  return (
    <div className={cn(fieldClass, "max-w-[420px]")}>
      <input
        type={reveal ? "text" : "password"}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label="API key"
        className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-zinc-700 outline-none placeholder:text-zinc-400 dark:text-zinc-300"
      />
      {value.trim() && <Pill tone="green">Saved</Pill>}
      <button
        type="button"
        onClick={() => setReveal((r) => !r)}
        className="text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        aria-label={reveal ? "Hide key" : "Show key"}
      >
        {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      {!value.trim() && (
        <button
          type="button"
          onClick={() => void paste()}
          className="text-xs font-medium text-blue-700 hover:underline dark:text-blue-400"
        >
          Paste
        </button>
      )}
    </div>
  );
}

type OllamaStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ok"; models: OllamaModel[] }
  | { kind: "error"; message: string };

function OllamaConfig({
  endpoint,
  activeModel,
  onEndpointChange,
  onModelChange,
}: {
  endpoint: string;
  activeModel: string;
  onEndpointChange: (value: string) => void;
  onModelChange: (id: string) => void;
}) {
  const [draft, setDraft] = useState(endpoint);
  const [status, setStatus] = useState<OllamaStatus>({ kind: "idle" });

  const runProbe = async (target: string) => {
    setStatus({ kind: "checking" });
    const normalized = normalizeEndpoint(target);
    if (!(await pingOllama(normalized))) {
      setStatus({
        kind: "error",
        message: `Couldn't reach Ollama at ${normalized}. Start it with \`ollama serve\` and test again.`,
      });
      return;
    }
    try {
      setStatus({ kind: "ok", models: await listOllamaModels(normalized) });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't list models." });
    }
  };

  // Refetch whenever the *committed* endpoint changes (not on every keystroke).
  useEffect(() => {
    setDraft(endpoint);
    void runProbe(endpoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint]);

  const commit = () => {
    if (draft !== endpoint) onEndpointChange(draft);
    else void runProbe(endpoint);
  };

  return (
    <>
      <SettingRow
        label="Endpoint"
        hint="Ollama runs on this computer, so there's no key. Change this if it listens on another port or host."
        keywords="ollama url host port local"
        control={
          <Button variant="link" onClick={() => openExternal("https://ollama.com/download")}>
            Install Ollama ↗
          </Button>
        }
        below={
          <div className={cn(fieldClass, "max-w-[420px]")}>
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                }
              }}
              placeholder={KEY_PLACEHOLDERS.ollama}
              aria-label="Ollama endpoint"
              className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
            />
            <button
              type="button"
              onClick={() => void runProbe(draft || endpoint)}
              disabled={status.kind === "checking"}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-400"
            >
              <RefreshCw size={11} className={cn(status.kind === "checking" && "animate-spin")} />
              {status.kind === "checking" ? "Testing…" : "Test"}
            </button>
          </div>
        }
      />
      <SettingRow
        label="Model"
        hint="Read live from your Ollama install."
        keywords="ollama model"
        control={
          status.kind === "ok" ? (
            <Pill tone="green">{status.models.length} installed</Pill>
          ) : status.kind === "error" ? (
            <Pill tone="rose">Not reachable</Pill>
          ) : null
        }
        below={<OllamaModelList status={status} activeModel={activeModel} onPick={onModelChange} />}
      />
    </>
  );
}

function OllamaModelList({
  status,
  activeModel,
  onPick,
}: {
  status: OllamaStatus;
  activeModel: string;
  onPick: (id: string) => void;
}) {
  const note = "m-0 text-xs text-zinc-500 dark:text-zinc-400";
  if (status.kind === "checking" || status.kind === "idle") {
    return <p className={note}>Loading installed models…</p>;
  }
  if (status.kind === "error") return <p className={note}>{status.message}</p>;
  if (status.models.length === 0) {
    return (
      <p className={note}>
        No models pulled yet. Try <span className="font-mono">ollama pull llama3.2</span>.
      </p>
    );
  }
  return (
    <OptionSet
      value={activeModel}
      options={status.models.map((m) => ({ id: m.name, label: m.name }))}
      onChange={onPick}
      ariaLabel="Ollama model"
    />
  );
}

// ─── Help & about ─────────────────────────────────────────────────────────

type Particle = {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  rotate: number;
  duration: number;
  kind: "burst" | "heart";
  // burst: solid-color confetti rectangle; heart: emoji glyph
  color?: string;
  width?: number;
  height?: number;
  emoji?: string;
};

const CONFETTI_COLORS = [
  "#ef4444",
  "#f59e0b",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#00f5d4",
] as const;

function AboutCategory({ s, platform }: { s: Settings; platform: Platform }) {
  const year = new Date().getFullYear();
  const version = useAppVersion();
  const updates = useUpdateCheck(s.general.checkUpdates);
  const [particles, setParticles] = useState<Particle[]>([]);
  const idRef = useRef(0);
  const lastEmitRef = useRef(0);

  const burstFromLogo = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const count = 40;
    const items: Particle[] = Array.from({ length: count }, (_, i) => {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 80 + Math.random() * 100;
      const duration = 900 + Math.random() * 500;
      return {
        id: idRef.current++,
        x: cx,
        y: cy,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist - 30,
        rotate: (Math.random() - 0.5) * 720,
        duration,
        kind: "burst",
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        width: 6 + Math.random() * 6,
        height: 3 + Math.random() * 3,
      };
    });
    setParticles((prev) => [...prev, ...items]);
    const ids = new Set(items.map((p) => p.id));
    window.setTimeout(() => setParticles((prev) => prev.filter((p) => !ids.has(p.id))), 1500);
  };

  const trailHeart = (clientX: number, clientY: number) => {
    const now = performance.now();
    if (now - lastEmitRef.current < 70) return;
    lastEmitRef.current = now;
    const id = idRef.current++;
    const item: Particle = {
      id,
      x: clientX,
      y: clientY,
      dx: (Math.random() - 0.5) * 30,
      dy: -50 - Math.random() * 30,
      rotate: (Math.random() - 0.5) * 60,
      duration: 900,
      emoji: "💗",
      kind: "heart",
    };
    setParticles((prev) => [...prev, item]);
    window.setTimeout(() => setParticles((prev) => prev.filter((p) => p.id !== id)), 1000);
  };

  const exportLog = async () => {
    const payload = {
      app: "LunoPeak",
      version,
      exportedAt: new Date().toISOString(),
      platform: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      settings: {
        ...s,
        apiKeys: { anthropic: "***", openai: "***", gemini: "***", xai: "***" },
      },
    };
    const json = JSON.stringify(payload, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const defaultName = `lunopeak-diagnostics-${stamp}.json`;

    try {
      if (isTauri()) {
        const path = await save({
          title: "Export diagnostics log",
          defaultPath: defaultName,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return;
        await api.writeDiagnosticsLog(path, json);
        toast.success("Diagnostics exported", path);
        return;
      }
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Diagnostics exported", defaultName);
    } catch (e) {
      toast.error("Couldn't export diagnostics", e instanceof Error ? e.message : String(e));
    }
  };

  const machine = platform === "macos" ? "this Mac" : "this computer";

  return (
    <>
      <SettingBlock
        keywords="version about lunopeak check for updates what's new release"
        className="flex items-center gap-3.5 rounded-xl border border-black/[0.07] bg-white p-4 dark:border-white/[0.08] dark:bg-white/[0.035]"
      >
        <button
          type="button"
          onClick={burstFromLogo}
          aria-label="LunoPeak"
          className="shrink-0 rounded-[11px] transition-transform hover:scale-105 active:scale-95"
        >
          <img src="/app-icon.png" alt="" aria-hidden className="size-12 rounded-[11px]" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">LunoPeak {version}</span>
          <span className={cn("text-[12.5px]", updates.toneClass)}>{updates.text}</span>
        </div>
        <Button onClick={() => void updates.check()} disabled={updates.checking}>
          Check for updates
        </Button>
        <Button onClick={() => useUpdateStore.getState().setWhatsNewOpen(true)}>What’s new</Button>
      </SettingBlock>

      <SettingsSection title="Help" caption="Stuck, or something isn’t working?">
        <LinkRow
          icon={HelpCircle}
          label="Questions and answers"
          hint="Common questions about limits, costs and setup"
          onClick={() => openExternal("https://lunopeak.com/#faq")}
        />
        <LinkRow
          icon={Bug}
          label="Report a problem"
          hint="Opens a new issue on GitHub"
          onClick={() => openExternal(`${REPO_URL}/issues/new`)}
        />
        <LinkRow
          icon={Lightbulb}
          label="Suggest a feature"
          hint="Share an idea with the developer"
          onClick={() => openExternal(`${REPO_URL}/issues/new?labels=idea`)}
        />
        <SettingRow
          label="Export diagnostics log"
          hint="Attach it to a bug report. API keys are removed."
          keywords="debug logs support"
          leading={<IconTile icon={FileText} />}
          control={<Button onClick={() => void exportLog()}>Export…</Button>}
        />
      </SettingsSection>

      <SettingsSection title="Privacy">
        <SettingBlock keywords="privacy telemetry account sync data" className="flex gap-3 py-3.5">
          <IconTile icon={ShieldCheck} tone="green" />
          <p className="m-0 flex-1 text-[13px] leading-[1.55] text-zinc-700 text-pretty dark:text-zinc-300">
            No account, no cloud sync and no telemetry. LunoPeak reads files on {machine} and only goes online
            to services you already use: Anthropic for plan limits, GitHub for updates.
          </p>
        </SettingBlock>
        <LinkRow
          icon={ShieldCheck}
          label="Privacy policy"
          hint="lunopeak.com/privacy"
          onClick={() => openExternal("https://lunopeak.com/privacy")}
        />
      </SettingsSection>

      <SettingsSection title="LunoPeak">
        <LinkRow icon={Globe} label="Website" hint="lunopeak.com" onClick={() => openExternal("https://lunopeak.com")} />
        <LinkRow
          icon={FileText}
          label="Release notes"
          hint="Every version and what changed"
          onClick={() => openExternal(RELEASES_URL)}
        />
        <LinkRow icon={Github} label="Source code" hint="github.com/idevtim/lunopeak" onClick={() => openExternal(REPO_URL)} />
      </SettingsSection>

      <SettingsSection
        title="Support development"
        caption="LunoPeak is free and will stay free. If it helps you, you can chip in."
      >
        <LinkRow
          icon={Heart}
          label="Sponsor on GitHub"
          hint="Monthly or one-time"
          onClick={() => openExternal("https://github.com/sponsors/idevtim")}
          onMouseMove={(e) => trailHeart(e.clientX, e.clientY)}
        />
        <LinkRow
          icon={Coffee}
          label="Buy Me a Coffee"
          hint="A one-time thank-you"
          onClick={() => openExternal("https://www.buymeacoffee.com/idevtim")}
        />
      </SettingsSection>

      <SettingBlock keywords="made by timothy murphy author copyright" className="px-0.5 py-0">
        <span className="text-xs text-zinc-400">
          Made by{" "}
          <button
            type="button"
            onClick={() => openExternal("https://www.idevtim.com")}
            className="text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
          >
            Timothy Murphy
          </button>{" "}
          · © {year} LunoPeak
        </span>
      </SettingBlock>

      {particles.length > 0 &&
        createPortal(
          <div className="pointer-events-none fixed inset-0 z-50">
            {particles.map((p) => (
              <span
                key={p.id}
                className={cn("lp-particle", p.kind === "burst" ? "lp-particle-burst" : "lp-particle-heart")}
                style={
                  {
                    left: p.x,
                    top: p.y,
                    animationDuration: `${p.duration}ms`,
                    "--lp-dx": `${p.dx}px`,
                    "--lp-dy": `${p.dy}px`,
                    "--lp-rot": `${p.rotate}deg`,
                    ...(p.kind === "burst"
                      ? {
                          width: p.width,
                          height: p.height,
                          background: p.color,
                          borderRadius: 1,
                          boxShadow: `0 0 4px ${p.color}80`,
                        }
                      : {}),
                  } as CSSProperties
                }
              >
                {p.kind === "heart" ? p.emoji : null}
              </span>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
