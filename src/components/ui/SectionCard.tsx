import type { HTMLAttributes, ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { tokens } from "@/lib/tokens";

interface SectionCardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  icon?: LucideIcon;
  iconImage?: string;
  action?: ReactNode;
  showChevron?: boolean;
  to?: string;
  bodyClassName?: string;
}

export function SectionCard({
  title,
  icon: Icon,
  iconImage,
  action,
  showChevron,
  to,
  className,
  bodyClassName,
  children,
  ...props
}: SectionCardProps) {
  const chevron = (showChevron || to) && (
    <ChevronRight
      size={15}
      strokeWidth={1.75}
      className={cn(
        tokens.text.quaternary,
        to && "transition-colors group-hover:text-zinc-700 dark:group-hover:text-zinc-300",
      )}
    />
  );
  const titleSide = (
    <div className="flex items-center gap-2">
      {iconImage ? (
        <img src={iconImage} alt="" aria-hidden className="size-4 rounded" />
      ) : (
        Icon && <Icon size={15} strokeWidth={1.75} className={tokens.text.tertiary} />
      )}
      {title && (
        <h3
          className={cn(
            "text-sm font-medium",
            tokens.text.secondary,
            to && "transition-colors group-hover:text-zinc-900 dark:group-hover:text-zinc-100",
          )}
        >
          {title}
        </h3>
      )}
    </div>
  );

  return (
    <div
      className={cn(
        "rounded-[14px] border border-black/[0.07] bg-white dark:border-white/[0.08] dark:bg-white/[0.035]",
        className,
      )}
      {...props}
    >
      {(title || action) &&
        (to ? (
          <a
            href={to}
            className="group flex items-center justify-between gap-3 px-[18px] pt-3.5 pb-2.5"
          >
            {titleSide}
            <div className="flex items-center gap-2">
              {action}
              {chevron}
            </div>
          </a>
        ) : (
          <div className="flex items-center justify-between gap-3 px-[18px] pt-3.5 pb-2.5">
            {titleSide}
            <div className="flex items-center gap-2">
              {action}
              {chevron}
            </div>
          </div>
        ))}
      <div className={cn("px-[18px] pb-4", title || action ? "pt-0.5" : "pt-4", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}
