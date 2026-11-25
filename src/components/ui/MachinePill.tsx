import { Monitor } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";

/**
 * Marks something that came from another of your machines (Settings → Other
 * machines). Violet, like other machines' bars in Costs, so remote rows read
 * the same way on every page. This machine's rows never carry one.
 */
export function MachinePill({ host, className }: { host: string; className?: string }) {
  return (
    <Pill tone="violet" className={cn("max-w-[160px] shrink-0", className)} title={`From ${host}, another of your machines`}>
      <Monitor size={11} strokeWidth={2} className="shrink-0" />
      <span className="truncate">{host}</span>
    </Pill>
  );
}
