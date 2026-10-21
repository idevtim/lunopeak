import {
  Activity,
  Bot,
  Boxes,
  CircleDot,
  ClipboardList,
  Coins,
  FileText,
  FolderGit2,
  GitBranch,
  GitCompare,
  Hammer,
  HardDriveDownload,
  Heart,
  History,
  Home,
  Layers,
  Leaf,
  Lock,
  Network,
  Plug,
  Radar,
  ScrollText,
  Settings,
  Sparkles,
  Wand2,
  type LucideIcon,
} from "lucide-react";

export type RouteId =
  | "dashboard"
  | "assistant"
  | "live"
  | "sessions"
  | "session-replay"
  | "repo-detail"
  | "transcripts"
  | "tools"
  | "costs"
  | "cost-detail"
  | "setup"
  | "ports"
  | "repos"
  | "work-graph"
  | "repo-pulse"
  | "timeline"
  | "diffs"
  | "snapshots"
  | "skills"
  | "agents"
  | "memory"
  | "hooks"
  | "hygiene"
  | "deps"
  | "worktrees"
  | "env"
  | "lint"
  | "settings";

export interface Route {
  id: RouteId;
  label: string;
  icon: LucideIcon;
  /** Phase number (1-6). Used for "coming in Phase X" placeholder. */
  phase: 1 | 2 | 3 | 4 | 5 | 6;
  /** Optional note rendered on the placeholder when not yet built. */
  note?: string;
}

export interface RouteSection {
  id: string;
  /** Empty for the unlabeled top group. */
  label: string;
  routes: Route[];
  foldedByDefault?: boolean;
}

/**
 * Sidebar layout. The first group (`top`) renders without a heading; the
 * rest are foldable sections. `foldedByDefault` sections start collapsed
 * until the user opens them (state lives in `settings.sidebar`).
 */
export const sections: RouteSection[] = [
  {
    id: "top",
    label: "",
    routes: [
      { id: "dashboard", label: "Home", icon: Home, phase: 2 },
      { id: "assistant", label: "Assistant", icon: Sparkles, phase: 5 },
      { id: "live", label: "Live", icon: Activity, phase: 2 },
    ],
  },
  {
    id: "activity",
    label: "Agent activity",
    routes: [
      { id: "sessions", label: "Sessions", icon: History, phase: 2 },
      { id: "transcripts", label: "Transcripts", icon: ScrollText, phase: 2 },
      { id: "tools", label: "Tools", icon: Hammer, phase: 4 },
      { id: "costs", label: "Costs", icon: Coins, phase: 2 },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    routes: [
      { id: "repos", label: "Repos", icon: FolderGit2, phase: 1 },
      { id: "work-graph", label: "Work graph", icon: Network, phase: 3 },
      { id: "timeline", label: "Timeline", icon: GitBranch, phase: 3 },
      { id: "diffs", label: "Diffs", icon: GitCompare, phase: 3 },
      { id: "repo-pulse", label: "Repo pulse", icon: Radar, phase: 3 },
    ],
  },
  {
    id: "setup",
    label: "Agent setup",
    foldedByDefault: true,
    routes: [
      { id: "setup", label: "Setup checklist", icon: ClipboardList, phase: 3 },
      { id: "skills", label: "Skills", icon: Wand2, phase: 3 },
      { id: "agents", label: "Subagents", icon: Bot, phase: 3 },
      { id: "memory", label: "Memory", icon: FileText, phase: 3 },
      { id: "hooks", label: "Hooks", icon: CircleDot, phase: 3 },
    ],
  },
  {
    id: "health",
    label: "Project health",
    routes: [
      { id: "hygiene", label: "Hygiene", icon: Heart, phase: 3 },
      { id: "lint", label: "Lint", icon: Leaf, phase: 4 },
      { id: "deps", label: "Dependencies", icon: Boxes, phase: 4 },
      { id: "env", label: "Environment", icon: Lock, phase: 4 },
      { id: "ports", label: "Ports", icon: Plug, phase: 2 },
    ],
  },
  {
    id: "backups",
    label: "Backups",
    foldedByDefault: true,
    routes: [
      { id: "snapshots", label: "Snapshots", icon: HardDriveDownload, phase: 6 },
      { id: "worktrees", label: "Worktrees", icon: Layers, phase: 4 },
    ],
  },
];

export const settingsRoute: Route = {
  id: "settings",
  label: "Settings",
  icon: Settings,
  phase: 1,
};

/** Routes reachable but not shown in the sidebar (deep links from elsewhere). */
const hiddenRoutes: Route[] = [
  {
    id: "session-replay",
    label: "Session replay",
    icon: History,
    phase: 2,
  },
  {
    id: "repo-detail",
    label: "Repo",
    icon: FolderGit2,
    phase: 1,
  },
  {
    id: "cost-detail",
    label: "Cost detail",
    icon: Coins,
    phase: 2,
  },
];

export const allRoutes: Route[] = [
  ...sections.flatMap((s) => s.routes),
  settingsRoute,
  ...hiddenRoutes,
];

export const defaultRouteId: RouteId = "dashboard";
