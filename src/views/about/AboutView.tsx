import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { exportDiagnostics } from "@/lib/diagnostics";
import { api } from "@/lib/tauri";

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; version: string }
  | { kind: "installing" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

type Particle = {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  rotate: number;
  duration: number;
  color: string;
  width: number;
  height: number;
};

const CONFETTI_COLORS = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#00f5d4", // teal — iDEVTim accent
] as const;

/**
 * About panel — built with inline styles so it's immune to the
 * Tailwind/CSS-variable cascade issues that previously made the text
 * invisible. Resolves theme once from `prefers-color-scheme` and hardcodes
 * hex colors.
 */
const COMPACT_HEIGHT = 410;
const EXPANDED_HEIGHT = 600;
const TOGGLE_DURATION_MS = 280;

export function AboutView() {
  const [version, setVersion] = useState<string>(isTauri() ? "…" : "dev");
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const [particles, setParticles] = useState<Particle[]>([]);
  const [showMaker, setShowMaker] = useState(false);
  const installRef = useRef<(() => Promise<void>) | null>(null);
  const idRef = useRef(0);
  const animRef = useRef<number | null>(null);

  const animateWindowHeight = async (target: number) => {
    if (!isTauri()) return;
    try {
      const win = getCurrentWindow();
      const factor = await win.scaleFactor();
      const innerSize = await win.innerSize();
      const startH = innerSize.height / factor;
      if (Math.abs(startH - target) < 1) return;

      // Cancel any in-flight animation so the new direction wins.
      if (animRef.current !== null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }

      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min((now - startTime) / TOGGLE_DURATION_MS, 1);
        // easeInOutCubic — matches the CSS transition feel
        const eased =
          t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const h = Math.round(startH + (target - startH) * eased);
        void win.setSize(new LogicalSize(460, h));
        if (t < 1) {
          animRef.current = requestAnimationFrame(step);
        } else {
          animRef.current = null;
        }
      };
      animRef.current = requestAnimationFrame(step);
    } catch (e) {
      console.warn("[about] window resize failed:", e);
    }
  };

  const toggleMaker = () => {
    const next = !showMaker;
    setShowMaker(next);
    void animateWindowHeight(next ? EXPANDED_HEIGHT : COMPACT_HEIGHT);
  };

  useEffect(() => {
    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    };
  }, []);

  // index.html ships a static pre-React splash (`#boot-splash-static`) that
  // <BootSplash /> normally removes once React mounts. The About window
  // never renders BootSplash (early-return in App.tsx), so we tear the
  // splash down here — otherwise the static logo sits on top of AboutView.
  useEffect(() => {
    document.getElementById("boot-splash-static")?.remove();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion()
        .then(setVersion)
        .catch(() => setVersion("?")),
    );
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    const q = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    if (new URLSearchParams(q).has("check")) void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = async () => {
    if (!isTauri()) {
      setStatus({ kind: "error", message: "Not available in browser mode." });
      return;
    }
    setStatus({ kind: "checking" });
    try {
      const { check: doCheck } = await import("@tauri-apps/plugin-updater");
      const result = await doCheck();
      if (result) {
        installRef.current = () => result.downloadAndInstall();
        setStatus({ kind: "available", version: result.version });
      } else {
        installRef.current = null;
        setStatus({ kind: "uptodate" });
      }
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const install = async () => {
    if (!installRef.current) return;
    setStatus({ kind: "installing" });
    try {
      await installRef.current();
      setStatus({ kind: "ready" });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const burstFromLogo = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const count = 36;
    const items: Particle[] = Array.from({ length: count }, (_, i) => {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const dist = 80 + Math.random() * 100;
      return {
        id: idRef.current++,
        x: cx,
        y: cy,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist - 30,
        rotate: (Math.random() - 0.5) * 720,
        duration: 900 + Math.random() * 500,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        width: 6 + Math.random() * 6,
        height: 3 + Math.random() * 3,
      };
    });
    setParticles((prev) => [...prev, ...items]);
    const ids = new Set(items.map((p) => p.id));
    window.setTimeout(
      () => setParticles((prev) => prev.filter((p) => !ids.has(p.id))),
      1500,
    );
  };

  const openLink = (url: string) => {
    if (isTauri()) {
      void import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
    } else {
      window.open(url, "_blank", "noreferrer");
    }
  };

  // Resolve theme once from the OS — index.css's `--color-fg/bg` would have
  // been ideal but they don't propagate reliably to the about webview.
  const dark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const fg = dark ? "#f4f4f5" : "#18181b";
  const muted = dark ? "#a1a1aa" : "#71717a";
  const bg = dark ? "#0a0a0e" : "#fafafa";
  const cardBg = dark ? "#18181b" : "#f4f4f5";
  const border = dark ? "#27272a" : "#e4e4e7";
  const teal = dark ? "#00f5d4" : "#0f766e";
  const mono =
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        background: bg,
        color: fg,
        display: "flex",
        flexDirection: "column",
        fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* Drag region across the top */}
      <div
        data-tauri-drag-region
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 36,
          zIndex: 10,
        }}
      />

      {/* Content */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "32px 28px 12px",
        }}
      >
        <button
          type="button"
          onClick={burstFromLogo}
          aria-label="LunoPeak"
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            marginBottom: 12,
            transition: "transform 120ms",
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.95)")}
          onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1.05)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.05)")}
        >
          <img
            src="/app-icon.png"
            alt=""
            aria-hidden
            style={{
              width: 72,
              height: 72,
              borderRadius: 16,
              boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
              display: "block",
            }}
          />
        </button>

        <div style={{ fontSize: 17, fontWeight: 600, color: fg }}>
          LunoPeak
        </div>
        <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
          Version {version}
        </div>
        <p
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: muted,
            textAlign: "center",
            margin: "10px 0 0",
            maxWidth: 320,
          }}
        >
          A local-first dashboard for your AI-assisted dev environment.
          No telemetry. No accounts.
        </p>

        {/* Update status row */}
        <div
          style={{
            marginTop: 14,
            width: "100%",
            border: `1px solid ${updateBorder(status, dark, border)}`,
            borderRadius: 12,
            background: updateBg(status, dark, cardBg),
            padding: "9px 14px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              flex: 1,
              fontSize: 12,
              color: updateLabelColor(status, dark, fg),
            }}
          >
            {updateLabel(status)}
          </div>
          <UpdateButton
            status={status}
            dark={dark}
            onCheck={() => void check()}
            onInstall={() => void install()}
            onRestart={() => void api.restartApp()}
          />
        </div>

        {/* Links */}
        <div
          style={{
            marginTop: 14,
            display: "flex",
            gap: 8,
            justifyContent: "center",
          }}
        >
          <Pill
            label="GitHub"
            onClick={() => openLink("https://github.com/idevtim/lunopeak")}
            dark={dark}
          />
          <Pill
            label="Releases"
            onClick={() =>
              openLink("https://github.com/idevtim/lunopeak/releases")
            }
            dark={dark}
          />
          <Pill
            label="♥ Sponsor"
            onClick={() => openLink("https://github.com/sponsors/idevtim")}
            dark={dark}
          />
          <Pill
            label="Coffee"
            icon={<CoffeeIcon />}
            onClick={() => openLink("https://www.buymeacoffee.com/idevtim")}
            dark={dark}
          />
        </div>

        {/* Disclosure toggle for the maker section */}
        <button
          onClick={() => void toggleMaker()}
          style={{
            marginTop: 10,
            background: "transparent",
            border: "none",
            color: muted,
            fontSize: 11,
            fontFamily: mono,
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = teal)}
          onMouseLeave={(e) => (e.currentTarget.style.color = muted)}
        >
          {showMaker ? "Hide" : "Who built this?"}
          <span
            style={{
              display: "inline-block",
              transition: "transform 180ms",
              transform: showMaker ? "rotate(180deg)" : "rotate(0deg)",
              fontSize: 10,
            }}
          >
            ▾
          </span>
        </button>

        {/* Maker — built by Timothy Murphy / iDEVTim */}
        <div
          aria-hidden={!showMaker}
          style={{
            width: "100%",
            overflow: "hidden",
            maxHeight: showMaker ? 280 : 0,
            opacity: showMaker ? 1 : 0,
            marginTop: showMaker ? 14 : 0,
            transition: `max-height ${TOGGLE_DURATION_MS}ms cubic-bezier(0.65, 0, 0.35, 1), opacity ${
              showMaker ? TOGGLE_DURATION_MS : Math.round(TOGGLE_DURATION_MS / 1.4)
            }ms ${showMaker ? "ease-out" : "ease-in"}, margin-top ${TOGGLE_DURATION_MS}ms cubic-bezier(0.65, 0, 0.35, 1)`,
            pointerEvents: showMaker ? "auto" : "none",
          }}
        >
          <div
            style={{
              paddingTop: 16,
              borderTop: `1px solid ${border}`,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <img
                src="/idevtim-avatar.jpg"
                alt="Timothy Murphy"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 8,
                  objectFit: "cover",
                  flexShrink: 0,
                  boxShadow: `0 0 0 1px ${teal}55, 0 4px 12px rgba(0,0,0,0.25)`,
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: fg }}>
                  Built by Timothy Murphy
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: muted,
                    fontFamily: mono,
                    marginTop: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  <span style={{ color: teal }}>~/iDEVTim</span>
                  <span style={{ padding: "0 6px", opacity: 0.5 }}>·</span>
                  solo dev
                  <span style={{ padding: "0 6px", opacity: 0.5 }}>·</span>
                  15+ years shipping software
                </div>
              </div>
            </div>

            <p
              style={{
                fontSize: 11,
                lineHeight: 1.55,
                color: muted,
                margin: "12px 0 0",
                textAlign: "left",
              }}
            >
              LunoPeak is a one-person project, made for every developer who
              lives in their terminal. Built without telemetry, without an
              account, and without ever leaving your machine.
            </p>

            <p
              style={{
                fontSize: 10,
                lineHeight: 1.4,
                color: muted,
                margin: "10px 0 0",
                fontFamily: mono,
                fontStyle: "italic",
                textAlign: "left",
              }}
            >
              <span style={{ color: teal }}>&gt;</span> You bring the vision. I
              handle the code.
            </p>

            <div
              style={{
                marginTop: 12,
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
              }}
            >
              <Pill
                label="idevtim.com"
                onClick={() => openLink("https://www.idevtim.com")}
                dark={dark}
              />
              <Pill
                label="X"
                onClick={() => openLink("https://x.com/idevtim")}
                dark={dark}
              />
              <Pill
                label="LinkedIn"
                onClick={() => openLink("https://linkedin.com/in/idevtim")}
                dark={dark}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer
        style={{
          borderTop: `1px solid ${border}`,
          padding: "9px 18px",
          fontSize: 11,
          color: muted,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span>© {new Date().getFullYear()} LunoPeak</span>
        <button
          onClick={() => void exportDiagnostics(version)}
          style={{
            background: "transparent",
            border: "none",
            color: muted,
            fontSize: 11,
            cursor: "pointer",
            padding: "3px 8px",
            borderRadius: 6,
          }}
        >
          Export Diagnostics
        </button>
      </footer>

      {/* Confetti portal — uses the lp-particle keyframes from index.css */}
      {particles.length > 0 &&
        createPortal(
          <div
            style={{
              position: "fixed",
              inset: 0,
              pointerEvents: "none",
              zIndex: 50,
            }}
          >
            {particles.map((p) => (
              <span
                key={p.id}
                className="lp-particle lp-particle-burst"
                style={
                  {
                    left: p.x,
                    top: p.y,
                    width: p.width,
                    height: p.height,
                    background: p.color,
                    borderRadius: 1,
                    boxShadow: `0 0 4px ${p.color}80`,
                    animationDuration: `${p.duration}ms`,
                    "--lp-dx": `${p.dx}px`,
                    "--lp-dy": `${p.dy}px`,
                    "--lp-rot": `${p.rotate}deg`,
                  } as CSSProperties
                }
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

// ─── Update row helpers ──────────────────────────────────────────────────

function updateLabel(s: UpdateStatus): string {
  switch (s.kind) {
    case "idle":
      return "Check for the latest LunoPeak release.";
    case "checking":
      return "Checking for updates…";
    case "uptodate":
      return "You're up to date.";
    case "available":
      return `LunoPeak ${s.version} is available.`;
    case "installing":
      return "Installing update…";
    case "ready":
      return "Installed — click Restart to apply.";
    case "error":
      return s.message;
  }
}

// Match the Settings → General "Check for Updates" colors:
// emerald for up-to-date, blue for available, rose for error.
function updateLabelColor(s: UpdateStatus, dark: boolean, fg: string): string {
  if (s.kind === "uptodate") return dark ? "#34d399" : "#047857";
  if (s.kind === "available" || s.kind === "ready")
    return dark ? "#60a5fa" : "#1d4ed8";
  if (s.kind === "error") return dark ? "#fb7185" : "#be123c";
  return fg;
}

function updateBorder(s: UpdateStatus, dark: boolean, fallback: string): string {
  if (s.kind === "uptodate")
    return dark ? "rgba(16, 185, 129, 0.35)" : "rgba(16, 185, 129, 0.45)";
  if (s.kind === "available" || s.kind === "ready")
    return dark ? "rgba(59, 130, 246, 0.35)" : "rgba(59, 130, 246, 0.45)";
  if (s.kind === "error")
    return dark ? "rgba(244, 63, 94, 0.35)" : "rgba(244, 63, 94, 0.45)";
  return fallback;
}

function updateBg(s: UpdateStatus, dark: boolean, fallback: string): string {
  if (s.kind === "uptodate")
    return dark ? "rgba(16, 185, 129, 0.10)" : "rgba(16, 185, 129, 0.08)";
  if (s.kind === "available" || s.kind === "ready")
    return dark ? "rgba(59, 130, 246, 0.10)" : "rgba(59, 130, 246, 0.08)";
  if (s.kind === "error")
    return dark ? "rgba(244, 63, 94, 0.10)" : "rgba(244, 63, 94, 0.08)";
  return fallback;
}

function UpdateButton({
  status,
  dark,
  onCheck,
  onInstall,
  onRestart,
}: {
  status: UpdateStatus;
  dark: boolean;
  onCheck: () => void;
  onInstall: () => void;
  onRestart: () => void;
}) {
  const busy = status.kind === "checking" || status.kind === "installing";
  if (status.kind === "available") {
    return (
      <button onClick={onInstall} disabled={busy} style={btn(true, dark, busy)}>
        Install
      </button>
    );
  }
  if (status.kind === "ready") {
    return (
      <button onClick={onRestart} style={btn(true, dark, false)}>
        Restart Now
      </button>
    );
  }
  return (
    <button onClick={onCheck} disabled={busy} style={btn(false, dark, busy)}>
      {busy ? "…" : "Check"}
    </button>
  );
}

function btn(
  primary: boolean,
  dark: boolean,
  disabled: boolean,
): React.CSSProperties {
  return {
    background: primary ? "#3b82f6" : dark ? "#27272a" : "#e4e4e7",
    color: primary ? "white" : dark ? "#f4f4f5" : "#18181b",
    border: "none",
    borderRadius: 8,
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 500,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

function Pill({
  label,
  icon,
  onClick,
  dark,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  dark: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: dark ? "#27272a" : "#e4e4e7",
        color: dark ? "#d4d4d8" : "#3f3f46",
        border: "none",
        borderRadius: 999,
        padding: "5px 12px",
        fontSize: 11,
        fontWeight: 500,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        lineHeight: 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function CoffeeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 2v2" />
      <path d="M14 2v2" />
      <path d="M6 2v2" />
      <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
    </svg>
  );
}
