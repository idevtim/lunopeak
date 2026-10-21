import { useEffect, useRef, useState } from "react";
import { useBootReady } from "@/hooks/useBootReady";
import { cn } from "@/lib/utils";

const FADE_MS = 250;

/**
 * `replay` plays the splash again mid-session (after first-run setup): the
 * zoom starts from its first frame instead of syncing to the static
 * pre-React splash's timeline.
 */
export function BootSplash({ replay = false }: { replay?: boolean }) {
  const ready = useBootReady();
  const [mounted, setMounted] = useState(true);

  // The pre-React splash sits underneath this overlay. Remove it once we've
  // taken over so it doesn't linger if React unmounts our overlay first.
  useEffect(() => {
    document.getElementById("boot-splash-static")?.remove();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => setMounted(false), FADE_MS);
    return () => clearTimeout(t);
  }, [ready]);

  if (!mounted) return null;

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-zinc-950",
        "transition-opacity duration-[250ms] ease-out",
        ready ? "opacity-0" : "opacity-100",
        replay && "animate-lp-fade-in",
      )}
    >
      <StarField />
      <Icon replay={replay} />
    </div>
  );
}

const ZOOM_MS = 900;

function Icon({ replay }: { replay: boolean }) {
  // The static splash in index.html starts the zoom the moment HTML parses.
  // React mounts a tick later — pin our animation timeline to navigation
  // start so the React icon picks up exactly where the static one left off.
  const elapsedRef = useRef(
    !replay && typeof performance !== "undefined" ? performance.now() : 0,
  );
  const elapsed = elapsedRef.current;
  const zoomDelay = -Math.min(elapsed, ZOOM_MS);
  const pulseDelay = Math.max(0, ZOOM_MS - elapsed);

  return (
    <div className="relative">
      <div
        className="absolute inset-0 -z-10 rounded-[28%] blur-2xl"
        style={{
          background:
            "radial-gradient(circle, rgba(99,102,241,0.45), rgba(59,130,246,0) 70%)",
        }}
      />
      <img
        src="/app-icon.png"
        alt=""
        draggable={false}
        className="size-28 select-none rounded-[28%] shadow-[0_10px_40px_rgba(0,0,0,0.6)]"
        style={{
          animation: `lunopeak-zoom-in ${ZOOM_MS}ms cubic-bezier(0.16, 1, 0.3, 1) ${zoomDelay}ms both, lunopeak-pulse 2.2s ease-in-out ${pulseDelay}ms infinite`,
        }}
      />
      <style>{`
        @keyframes lunopeak-zoom-in {
          0%   { transform: scale(0.35); opacity: 0; filter: brightness(1.4); }
          60%  { opacity: 1; }
          100% { transform: scale(1); opacity: 1; filter: brightness(1); }
        }
        @keyframes lunopeak-pulse {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          50%      { transform: scale(1.04); filter: brightness(1.12); }
        }
      `}</style>
    </div>
  );
}

interface Star {
  x: number;
  y: number;
  z: number;
  pz: number;
}

function StarField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
    };
    resize();
    window.addEventListener("resize", resize);

    const NUM = 280;
    const stars: Star[] = Array.from({ length: NUM }, () => ({
      x: (Math.random() - 0.5) * 2,
      y: (Math.random() - 0.5) * 2,
      z: Math.random() * 0.95 + 0.05,
      pz: 0,
    }));
    for (const s of stars) s.pz = s.z;

    let raf = 0;
    let last = performance.now();
    const speed = 0.85;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const k = Math.min(w, h) * 0.55;

      // Trail fade — keeps streaks but clears the frame steadily.
      ctx.fillStyle = "rgba(10, 10, 11, 0.3)";
      ctx.fillRect(0, 0, w, h);

      ctx.lineCap = "round";

      for (const s of stars) {
        s.pz = s.z;
        s.z -= speed * dt;
        if (s.z <= 0.02) {
          s.x = (Math.random() - 0.5) * 2;
          s.y = (Math.random() - 0.5) * 2;
          s.z = 1;
          s.pz = 1;
        }

        const sx = (s.x / s.z) * k + cx;
        const sy = (s.y / s.z) * k + cy;
        const psx = (s.x / s.pz) * k + cx;
        const psy = (s.y / s.pz) * k + cy;

        const depth = 1 - s.z;
        const alpha = Math.min(1, depth * 1.6);
        const width = Math.max(0.5, depth * 2) * dpr;

        ctx.strokeStyle = `rgba(220, 230, 255, ${alpha})`;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(psx, psy);
        ctx.lineTo(sx, sy);
        ctx.stroke();
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
    />
  );
}
