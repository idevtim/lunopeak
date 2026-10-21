import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function Switch({ checked, onChange, disabled, ariaLabel }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
        "border-black/[0.08] dark:border-white/[0.08] disabled:pointer-events-none disabled:opacity-40",
        checked ? "bg-blue-500" : "bg-black/[0.08] dark:bg-white/[0.06]",
      )}
    >
      <span
        className={cn(
          "block size-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
