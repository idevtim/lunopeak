import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Camera,
  Check,
  ExternalLink,
  FileDown,
  Gift,
  Github,
  Heart,
  Info,
  MessageSquarePlus,
  Monitor,
  Moon,
  Search,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { allRoutes, sections, settingsRoute, type RouteId } from "@/routes";
import { useHashRoute } from "@/hooks/useHashRoute";
import { usePlatform } from "@/hooks/usePlatform";
import { useUpdateSettings } from "@/hooks/useUpdateSettings";
import { cn, openExternal } from "@/lib/utils";
import { api } from "@/lib/tauri";
import { exportDiagnostics, getAppVersion } from "@/lib/diagnostics";
import { checkForUpdates, RELEASES_URL } from "@/lib/updates";
import { toast } from "@/stores/toastStore";
import { usePaletteStore } from "@/stores/paletteStore";
import { useUpdateStore } from "@/stores/updateStore";
import { useAssistantStore } from "@/stores/assistantStore";
import type { Settings } from "@/types/api";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Group = "Pages" | "Actions" | "Appearance" | "Settings" | "More";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: Group;
  icon: LucideIcon;
  /** Lower-cased haystack used by the ranker. */
  keywords: string;
  /** Hidden until the user types — keeps the empty palette short. */
  searchOnly?: boolean;
  active?: boolean;
  perform: () => void | Promise<void>;
}

/** Pages shown before the user types anything. */
const EMPTY_PAGE_COUNT = 7;

const GROUP_ORDER: Group[] = ["Pages", "Actions", "Appearance", "Settings", "More"];

/**
 * Global "Go to…" palette. ⌘K / Ctrl+K, the View menu (`app://palette`) or
 * the sidebar button open it. ↑/↓ move, Enter runs, Esc closes. Ranking is
 * a substring + token-boundary score — no fuzzy library, no surprises.
 */
export function CommandPalette() {
  const { navigateTo, navigate } = useHashRoute();
  const open = usePaletteStore((s) => s.open);
  const setOpen = usePaletteStore((s) => s.setOpen);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const platform = usePlatform();
  const { settings, update } = useUpdateSettings();
  const currentTheme = settings?.theme ?? "system";

  const setTheme = useCallback(
    (theme: Settings["theme"]) => update((s) => ({ ...s, theme })),
    [update],
  );

  const items: PaletteItem[] = useMemo(() => {
    const sectionFor = (id: RouteId) =>
      sections.find((s) => s.routes.some((r) => r.id === id))?.label || undefined;

    const pageItems: PaletteItem[] = allRoutes
      // Detail routes need a parent context (a repo, a session).
      .filter((r) => !["session-replay", "repo-detail", "cost-detail"].includes(r.id))
      .map((r) => ({
        id: `nav:${r.id}`,
        label: r.label,
        hint: sectionFor(r.id),
        group: "Pages" as const,
        icon: r.icon,
        keywords: `${r.label} ${r.id} ${sectionFor(r.id) ?? ""}`.toLowerCase(),
        perform: () => navigate(r.id),
      }));

    const actionItems: PaletteItem[] = [
      {
        id: "act:snapshot",
        label: "Take a snapshot",
        hint: "Save the state of every repo",
        group: "Actions",
        icon: Camera,
        keywords: "take a snapshot backup save",
        perform: () => navigateTo("snapshots", { take: "1" }),
      },
      {
        id: "act:new-chat",
        label: "New assistant chat",
        group: "Actions",
        icon: MessageSquarePlus,
        keywords: "new assistant chat conversation ask",
        perform: () => {
          useAssistantStore.getState().newConversation();
          navigate("assistant");
        },
      },
      {
        id: "act:check-updates",
        label: "Check for updates",
        group: "Actions",
        icon: ArrowDownToLine,
        keywords: "check for updates new release version",
        perform: () => void checkForUpdates(),
      },
      {
        id: "act:export-log",
        label: "Export diagnostics log",
        group: "Actions",
        icon: FileDown,
        keywords: "export diagnostics log debug snapshot",
        perform: async () => {
          const v = await getAppVersion();
          await exportDiagnostics(v);
        },
      },
      {
        id: "act:whats-new",
        label: "What's new",
        group: "Actions",
        icon: Gift,
        keywords: "what's new whats new release notes changelog",
        perform: () => useUpdateStore.getState().setWhatsNewOpen(true),
      },
    ];

    const themes: Array<{ id: Settings["theme"]; label: string; icon: LucideIcon }> = [
      { id: "light", label: "Light", icon: Sun },
      { id: "dark", label: "Dark", icon: Moon },
      { id: "system", label: "Match system", icon: Monitor },
    ];
    const themeItems: PaletteItem[] = themes.map((t) => ({
      id: `theme:${t.id}`,
      label: t.label,
      group: "Appearance" as const,
      icon: t.icon,
      keywords: `theme appearance mode ${t.id} ${t.label}`.toLowerCase(),
      active: currentTheme === t.id,
      perform: () => setTheme(t.id),
    }));

    const settingsCategories: Array<{ id: string; label: string }> = [
      { id: "general", label: "General" },
      { id: "agents", label: "Agents & projects" },
      { id: "menubar", label: platform === "macos" ? "Menu bar" : "System tray" },
      { id: "alerts", label: "Alerts & budget" },
      { id: "appearance", label: "Appearance" },
      { id: "editors", label: "Editors & terminal" },
      { id: "assistant", label: "Assistant" },
      { id: "about", label: "Help & about" },
    ];
    const settingsItems: PaletteItem[] = settingsCategories.map((c) => ({
      id: `settings:${c.id}`,
      label: `Settings › ${c.label}`,
      group: "Settings" as const,
      icon: settingsRoute.icon,
      keywords: `settings preferences ${c.label}`.toLowerCase(),
      searchOnly: true,
      perform: () => navigateTo("settings", { tab: c.id }),
    }));

    const moreItems: PaletteItem[] = [
      {
        id: "act:about",
        label: "About LunoPeak",
        group: "More",
        icon: Info,
        keywords: "about version credits",
        searchOnly: true,
        perform: async () => {
          if (isTauri()) await api.openAboutWindow();
          else window.open("#/about", "about", "width=460,height=540");
        },
      },
      {
        id: "act:github",
        label: "Open GitHub",
        hint: "github.com/idevtim/lunopeak",
        group: "More",
        icon: Github,
        keywords: "github source code repository",
        searchOnly: true,
        perform: () => openExternal("https://github.com/idevtim/lunopeak"),
      },
      {
        id: "act:releases",
        label: "Release notes",
        group: "More",
        icon: ExternalLink,
        keywords: "releases changelog notes versions",
        searchOnly: true,
        perform: () => openExternal(RELEASES_URL),
      },
      {
        id: "act:sponsor",
        label: "Sponsor on GitHub",
        group: "More",
        icon: Heart,
        keywords: "sponsor donate support github sponsors",
        searchOnly: true,
        perform: () => openExternal("https://github.com/sponsors/idevtim"),
      },
    ];

    return [...pageItems, ...actionItems, ...themeItems, ...settingsItems, ...moreItems];
  }, [navigate, navigateTo, currentTheme, setTheme, platform]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return items.filter((it) => !it.searchOnly);
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    const score = (it: PaletteItem) => {
      let s = 0;
      const hay = it.keywords;
      for (const t of tokens) {
        const idx = hay.indexOf(t);
        if (idx === -1) return -1;
        s += idx === 0 ? 4 : hay[idx - 1] === " " ? 2 : 1;
      }
      // Exact-prefix label match wins — `ho` lands on Home before Hooks.
      if (it.label.toLowerCase().startsWith(q)) s += 5;
      return s;
    };
    return items
      .map((it) => ({ it, s: score(it) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it);
  }, [items, query]);

  const grouped = useMemo(() => {
    const searching = query.trim().length > 0;
    const map = new Map<Group, PaletteItem[]>();
    for (const it of filtered) {
      const arr = map.get(it.group);
      if (arr) arr.push(it);
      else map.set(it.group, [it]);
    }
    // Stable group order regardless of ranking — keeps rows from jumping.
    return GROUP_ORDER.map((g) => {
      let groupItems = map.get(g) ?? [];
      if (g === "Pages" && !searching) groupItems = groupItems.slice(0, EMPTY_PAGE_COUNT);
      return { group: g, items: groupItems };
    }).filter((x) => x.items.length > 0);
  }, [filtered, query]);

  const flatList = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
  }, [setOpen]);

  // Hotkey. Handled in the webview on every platform: on macOS the app runs
  // as an accessory (no Dock icon), so the native menu's ⌘K accelerator
  // can't be relied on to fire. When the menu *does* fire too, its
  // `app://palette` lands right after this keydown and is ignored below so
  // one press never toggles twice.
  const lastKeyToggle = useRef(0);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isHotkey =
        e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (!isHotkey) return;
      e.preventDefault();
      lastKeyToggle.current = Date.now();
      usePaletteStore.getState().toggle();
      setQuery("");
      setHighlight(0);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Menu-driven open ("View → Go to…", or its ⌘K accelerator).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void listen("app://palette", () => {
      if (Date.now() - lastKeyToggle.current < 400) return;
      setQuery("");
      setHighlight(0);
      usePaletteStore.getState().toggle();
    }).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-palette-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  if (!open) return null;

  const runItem = (it: PaletteItem) => {
    close();
    void Promise.resolve(it.perform()).catch((e) =>
      toast.error("That didn't work", e instanceof Error ? e.message : String(e)),
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(flatList.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = flatList[highlight];
      if (it) runItem(it);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  let index = -1;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-zinc-900/[0.18] pt-[110px] animate-lp-fade-in"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[480px] w-[580px] max-w-[calc(100vw-32px)] flex-col self-start overflow-hidden rounded-[14px] bg-white/[0.97] shadow-[0_24px_70px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(0,0,0,0.2)] animate-lp-pop-in dark:bg-zinc-900/[0.97] dark:shadow-[0_24px_70px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(255,255,255,0.14)]"
      >
        <div className="flex items-center gap-2.5 border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.08]">
          <Search size={16} strokeWidth={2} className="text-zinc-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Go to a page, setting or action…"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
          />
          <kbd className="rounded-[5px] border border-black/10 px-1.5 py-px font-sans text-[11px] text-zinc-400 dark:border-white/[0.12]">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto p-1.5">
          {grouped.length === 0 ? (
            <div className="p-7 text-center text-[13px] text-zinc-500">
              Nothing matches “{query}”.
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.group} className="flex flex-col">
                <span className="px-2.5 pb-1 pt-2 text-[11.5px] font-semibold text-zinc-500">
                  {g.group}
                </span>
                {g.items.map((it) => {
                  index += 1;
                  const idx = index;
                  const active = idx === highlight;
                  const Icon = it.icon;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      data-palette-index={idx}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => runItem(it)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-zinc-900 dark:text-zinc-100",
                        active && "bg-blue-500/12 dark:bg-blue-500/20",
                      )}
                    >
                      <Icon
                        size={15}
                        strokeWidth={1.75}
                        className={cn(
                          "shrink-0",
                          active ? "text-blue-600 dark:text-blue-400" : "text-zinc-500 dark:text-zinc-400",
                        )}
                      />
                      <span className="flex-1 truncate text-[13.5px]">{it.label}</span>
                      {it.active && <Check size={13} strokeWidth={2.25} className="text-blue-600 dark:text-blue-400" />}
                      {it.hint && <span className="text-xs text-zinc-500 dark:text-zinc-400">{it.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex gap-4 border-t border-black/[0.06] px-4 py-2 text-[11.5px] text-zinc-500 dark:border-white/[0.08]">
          <span>↑ ↓ to move</span>
          <span>↵ to open</span>
          <span className="flex-1" />
          <span>{platform === "macos" ? "⌘K" : "Ctrl K"} anywhere</span>
        </div>
      </div>
    </div>
  );
}
