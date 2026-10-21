import { lazy, Suspense, useDeferredValue, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "@/components/layout/AppShell";
import { BootSplash } from "@/components/BootSplash";
import { FirstRunSetup } from "@/components/setup/FirstRunSetup";
import { GlobalErrorOverlay } from "@/components/GlobalErrorOverlay";
import { UpdateBar } from "@/components/UpdateBar";
import { WhatsNewDialog } from "@/components/WhatsNewDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { UpdateAutoCheckPrompt } from "@/components/UpdateAutoCheckPrompt";
import { Toaster } from "@/components/ui/Toaster";
import { EditorPicker } from "@/components/EditorPicker";
import { useBudgetAlerts } from "@/hooks/useBudgetAlerts";
import { useUsageAlerts } from "@/hooks/useUsageAlerts";
import { useNotificationOnboarding } from "@/hooks/useNotificationOnboarding";
import { useHashRoute } from "@/hooks/useHashRoute";
import { useTheme } from "@/hooks/useTheme";
import { queries } from "@/lib/queries";
import { api } from "@/lib/tauri";
import { allRoutes, type RouteId } from "@/routes";
import { DashboardView } from "@/views/dashboard/DashboardView";
import { SettingsView } from "@/views/settings/SettingsView";
import { AssistantView } from "@/views/assistant/AssistantView";
import { PlaceholderView } from "@/views/_placeholder/PlaceholderView";
import { AboutView } from "@/views/about/AboutView";
import { TrayPanelView } from "@/views/tray-panel/TrayPanelView";
import { CommandPalette } from "@/components/CommandPalette";
import { Page } from "@/components/ui/Page";
import { Bone, PageLoading } from "@/components/ui/PageStates";
import { RepoListSkeleton } from "@/views/repos/RepoListSkeleton";
import { CostsSkeleton } from "@/views/costs/CostsSkeleton";
import { SessionsSkeleton } from "@/views/sessions/SessionsSkeleton";
import { LiveSkeleton } from "@/views/live/LiveSkeleton";
import { exportDiagnostics, getAppVersion } from "@/lib/diagnostics";

// Lazy-loaded views: each becomes its own chunk, so the initial bundle only
// pays for the dashboard. Skeletons stay in the main bundle (small, shape-
// matched) so the Suspense fallback can render a real placeholder while the
// view chunk fetches — otherwise the view's own skeleton (gated on data
// loading) never gets a turn because data is usually already cached by the
// time the chunk lands.
const ReposView = lazy(() =>
  import("@/views/repos/ReposView").then((m) => ({ default: m.ReposView })),
);
const RepoDetailView = lazy(() =>
  import("@/views/repos/RepoDetailView").then((m) => ({ default: m.RepoDetailView })),
);
const LiveView = lazy(() =>
  import("@/views/live/LiveView").then((m) => ({ default: m.LiveView })),
);
const SessionsView = lazy(() =>
  import("@/views/sessions/SessionsView").then((m) => ({ default: m.SessionsView })),
);
const SessionReplayView = lazy(() =>
  import("@/views/sessions/SessionReplayView").then((m) => ({ default: m.SessionReplayView })),
);
const CostsView = lazy(() =>
  import("@/views/costs/CostsView").then((m) => ({ default: m.CostsView })),
);
const CostDetailView = lazy(() =>
  import("@/views/costs/CostDetailView").then((m) => ({ default: m.CostDetailView })),
);
const TranscriptsView = lazy(() =>
  import("@/views/transcripts/TranscriptsView").then((m) => ({ default: m.TranscriptsView })),
);
const PortsView = lazy(() =>
  import("@/views/ports/PortsView").then((m) => ({ default: m.PortsView })),
);
const MemoryView = lazy(() =>
  import("@/views/memory/MemoryView").then((m) => ({ default: m.MemoryView })),
);
const SkillsView = lazy(() =>
  import("@/views/skills/SkillsView").then((m) => ({ default: m.SkillsView })),
);
const AgentsView = lazy(() =>
  import("@/views/agents/AgentsView").then((m) => ({ default: m.AgentsView })),
);
const HooksView = lazy(() =>
  import("@/views/hooks/HooksView").then((m) => ({ default: m.HooksView })),
);
const HygieneView = lazy(() =>
  import("@/views/hygiene/HygieneView").then((m) => ({ default: m.HygieneView })),
);
const SetupView = lazy(() =>
  import("@/views/setup/SetupView").then((m) => ({ default: m.SetupView })),
);
const DiffsView = lazy(() =>
  import("@/views/diffs/DiffsView").then((m) => ({ default: m.DiffsView })),
);
const TimelineView = lazy(() =>
  import("@/views/timeline/TimelineView").then((m) => ({ default: m.TimelineView })),
);
const RepoPulseView = lazy(() =>
  import("@/views/repo-pulse/RepoPulseView").then((m) => ({ default: m.RepoPulseView })),
);
const WorkGraphView = lazy(() =>
  import("@/views/work-graph/WorkGraphView").then((m) => ({ default: m.WorkGraphView })),
);
const ToolsView = lazy(() =>
  import("@/views/tools/ToolsView").then((m) => ({ default: m.ToolsView })),
);
const DepsView = lazy(() =>
  import("@/views/deps/DepsView").then((m) => ({ default: m.DepsView })),
);
const WorktreesView = lazy(() =>
  import("@/views/worktrees/WorktreesView").then((m) => ({ default: m.WorktreesView })),
);
const EnvView = lazy(() =>
  import("@/views/env/EnvView").then((m) => ({ default: m.EnvView })),
);
const LintView = lazy(() =>
  import("@/views/lint/LintView").then((m) => ({ default: m.LintView })),
);
const SnapshotsView = lazy(() =>
  import("@/views/snapshots/SnapshotsView").then((m) => ({ default: m.SnapshotsView })),
);

/** Shown while a lazy view's chunk loads, named for the page being opened. */
const loadingCaption: Partial<Record<RouteId, string>> = {
  assistant: "Opening your chats…",
  transcripts: "Gathering your conversations…",
  tools: "Counting the tools your agents used…",
  "cost-detail": "Adding up this project's spending…",
  "work-graph": "Reading commits, branches and pull requests…",
  timeline: "Lining up commits and sessions…",
  diffs: "Collecting what each session changed…",
  "repo-pulse": "Checking which repos need a look…",
  setup: "Checking how your agents are set up…",
  skills: "Finding your skills…",
  agents: "Finding your subagents…",
  memory: "Finding your memory files…",
  hooks: "Reading your hooks…",
  hygiene: "Looking for things worth cleaning up…",
  lint: "Checking your CLAUDE.md files…",
  deps: "Checking your dependencies…",
  env: "Finding your .env files…",
  ports: "Checking which ports are in use…",
  snapshots: "Loading your snapshots…",
  worktrees: "Finding your worktrees…",
  settings: "Loading your settings…",
};

function GenericViewSkeleton({ route }: { route: RouteId }) {
  const label = allRoutes.find((r) => r.id === route)?.label ?? "this page";
  return (
    <Page>
      <PageLoading caption={loadingCaption[route] ?? `Opening ${label}…`}>
        <Bone className="h-7 w-48 rounded-lg" />
        <Bone className="h-4 w-96 rounded-md" />
        <div className="grid gap-3 md:grid-cols-2">
          <Bone className="h-24" />
          <Bone className="h-24" />
        </div>
        <Bone className="h-64" />
      </PageLoading>
    </Page>
  );
}

const fallbackByRoute: Partial<Record<RouteId, () => React.ReactElement>> = {
  repos: () => <RepoListSkeleton />,
  "repo-detail": () => <RepoListSkeleton />,
  costs: () => <CostsSkeleton />,
  sessions: () => <SessionsSkeleton />,
  "session-replay": () => <SessionsSkeleton />,
  live: () => <LiveSkeleton />,
};

const liveViews: Partial<Record<RouteId, () => React.ReactElement>> = {
  dashboard: () => <DashboardView />,
  settings: () => <SettingsView />,
  repos: () => <ReposView />,
  "repo-detail": () => <RepoDetailView />,
  live: () => <LiveView />,
  sessions: () => <SessionsView />,
  "session-replay": () => <SessionReplayView />,
  costs: () => <CostsView />,
  "cost-detail": () => <CostDetailView />,
  transcripts: () => <TranscriptsView />,
  ports: () => <PortsView />,
  memory: () => <MemoryView />,
  skills: () => <SkillsView />,
  agents: () => <AgentsView />,
  hooks: () => <HooksView />,
  hygiene: () => <HygieneView />,
  setup: () => <SetupView />,
  diffs: () => <DiffsView />,
  timeline: () => <TimelineView />,
  "repo-pulse": () => <RepoPulseView />,
  "work-graph": () => <WorkGraphView />,
  tools: () => <ToolsView />,
  deps: () => <DepsView />,
  worktrees: () => <WorktreesView />,
  env: () => <EnvView />,
  lint: () => <LintView />,
  assistant: () => <AssistantView />,
  snapshots: () => <SnapshotsView />,
};

export function App() {
  const { route, navigate } = useHashRoute();

  // The About window opens at `#/about` in a separate webview. Render only
  // the AboutView there — no shell, no boot splash, no global overlays.
  // The hash-router falls back to `dashboard` for unknown routes, so we
  // detect the about path directly off `window.location.hash` instead.
  const isAboutWindow =
    typeof window !== "undefined" &&
    /^#\/?about(\?|$)/.test(window.location.hash);
  if (isAboutWindow) {
    return <AboutView />;
  }

  // The tray popover opens in a frameless 'tray-panel' webview, also off the
  // hash. Same early-return pattern — the panel has its own chrome and is
  // sized too small for the AppShell to fit.
  const isTrayPanel =
    typeof window !== "undefined" &&
    /^#\/?tray-panel(\?|$)/.test(window.location.hash);
  if (isTrayPanel) {
    return <TrayPanelView />;
  }

  // The body view is driven by the deferred route. When the user navigates
  // to a lazy-loaded view, React keeps the previous view rendered while the
  // new chunk fetches — so the Suspense fallback never flashes between the
  // generic skeleton and the view's own internal isLoading skeleton. Once
  // the chunk lands, the deferred value catches up and the new view mounts;
  // its inline skeleton (gated on data loading) handles the next phase.
  const renderRoute = useDeferredValue(route);
  const Live = liveViews[renderRoute];
  const meta = allRoutes.find((r) => r.id === renderRoute)!;
  // Sidebar uses the eager route so the highlight updates the moment the
  // user clicks, even while the body still shows the previous view.
  const sidebarCurrent: RouteId =
    route === "session-replay"
      ? "sessions"
      : route === "repo-detail"
        ? "repos"
        : route === "cost-detail"
          ? "costs"
          : route;

  useBudgetAlerts();
  useUsageAlerts();
  useNotificationOnboarding();

  const queryClient = useQueryClient();
  const settings = useQuery(queries.settings);
  const showScrollbars = settings.data?.general.showScrollbars ?? false;
  useEffect(() => {
    document.documentElement.dataset.showScrollbars = showScrollbars ? "true" : "false";
    // WebKit otherwise repaints the scrollbar lazily — touch the layout so
    // the new gutter width takes effect on the current frame, not "after
    // the next scroll" or "after a reload."
    void document.body.offsetHeight;
  }, [showScrollbars]);

  useTheme(settings.data?.theme ?? "system");

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const unlistens: Array<() => void> = [];
    void listen<string>("tray://navigate", (event) => {
      const target = event.payload as RouteId;
      if (allRoutes.some((r) => r.id === target)) navigate(target);
    }).then((fn) => unlistens.push(fn));
    void listen("app://export-log", async () => {
      const version = await getAppVersion();
      await exportDiagnostics(version);
    }).then((fn) => unlistens.push(fn));
    // Fired by the Rust side when the main window goes from hidden to
    // visible (close-to-tray, then reopened from the tray). Active queries
    // refetch in the background — existing data stays painted so there's
    // no skeleton flash.
    void listen("app://reopened", () => {
      void queryClient.invalidateQueries();
    }).then((fn) => unlistens.push(fn));
    // macOS two-process: the tray panel's in-panel Settings writes from the
    // menu-bar agent, whose `settings://changed` never reaches this process.
    // Refetch on focus so we don't render — or write back — a stale copy
    // that would clobber what the user just changed up there.
    const onFocus = () => {
      void queryClient.invalidateQueries({ queryKey: queries.settings.queryKey });
    };
    window.addEventListener("focus", onFocus);
    unlistens.push(() => window.removeEventListener("focus", onFocus));
    // macOS two-process: when the menu bar's "Settings" spawns this window
    // process fresh, it leaves a pending route the backend hands us here. Pull
    // it once on mount and navigate. No-op (null) in every other case.
    void api.takePendingRoute().then((target) => {
      if (target && allRoutes.some((r) => r.id === target)) {
        navigate(target as RouteId);
      }
    });
    return () => {
      unlistens.forEach((fn) => fn());
    };
  }, [navigate, queryClient]);

  return (
    <>
      <AppShell current={sidebarCurrent} onNavigate={navigate}>
        <Suspense
          fallback={
            fallbackByRoute[renderRoute]?.() ?? <GenericViewSkeleton route={renderRoute} />
          }
        >
          {Live ? <Live /> : <PlaceholderView route={meta} />}
        </Suspense>
      </AppShell>
      <FirstRunSetup />
      <UpdateBar />
      <WhatsNewDialog />
      <UpdateAutoCheckPrompt />
      <BootSplash />
      <Toaster />
      <EditorPicker />
      <CommandPalette />
      <ConfirmDialog />
      <GlobalErrorOverlay />
    </>
  );
}
