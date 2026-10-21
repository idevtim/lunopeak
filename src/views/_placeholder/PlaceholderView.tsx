import { Construction } from "lucide-react";
import type { Route } from "@/routes";

interface PlaceholderViewProps {
  route: Route;
}

export function PlaceholderView({ route }: PlaceholderViewProps) {
  const Icon = route.icon;
  return (
    <div className="flex h-[calc(100vh-10rem)] items-center justify-center">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02]">
          <Icon className="size-5 text-zinc-600 dark:text-zinc-400" strokeWidth={1.75} />
        </div>
        <h2 className="text-lg font-medium text-zinc-800 dark:text-zinc-200">{route.label}</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Lands in Phase {route.phase}.
        </p>
        {route.note && (
          <p className="mt-3 text-xs leading-relaxed text-zinc-400 dark:text-zinc-400">
            {route.note}
          </p>
        )}
        <div className="mt-4 flex items-center gap-1.5 rounded-full border border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] px-3 py-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <Construction className="size-3" strokeWidth={2} />
          <span>Under construction</span>
        </div>
      </div>
    </div>
  );
}
