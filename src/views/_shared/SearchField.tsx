import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** White search input used by the Agent setup pages (Skills, Subagents, Memory). */
export function SearchField({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 focus-within:border-blue-500/50 dark:border-white/[0.12] dark:bg-white/[0.04]",
        className,
      )}
    >
      <Search size={13} strokeWidth={2} className="shrink-0 text-zinc-400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
      />
    </label>
  );
}
