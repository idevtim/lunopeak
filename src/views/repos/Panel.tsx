import type { ReactNode } from "react";
import { Card } from "@/components/ui/Page";
import { cn } from "@/lib/utils";

/** Padded card (14/18/16) with a 14px title and an optional right-side link or control. Shared by the Projects pages. */
export function PanelCard({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
      <div className="flex items-center gap-2">
        <h3 className="m-0 flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
        {aside}
      </div>
      {children}
    </Card>
  );
}

export function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs text-blue-600 hover:underline dark:text-blue-400"
    >
      {children}
    </button>
  );
}

export function ListRow({ first, className, children }: { first: boolean; className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 py-[7px]",
        !first && "border-t border-black/[0.05] dark:border-white/[0.06]",
        className,
      )}
    >
      {children}
    </div>
  );
}
