import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost" | "link";

interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  /** `sm` is the in-row action size (12.5px); `md` is for dialogs and empty states (13px). */
  size?: "sm" | "md";
}

export const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
  secondary:
    "border border-black/10 bg-white text-zinc-900 hover:bg-zinc-100 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-zinc-100 dark:hover:bg-white/[0.1]",
  destructive: "bg-rose-600 text-white hover:bg-rose-700",
  ghost:
    "text-zinc-700 hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100",
  link: "!px-0 text-blue-600 hover:underline dark:text-blue-400",
};

export function buttonClass(variant: ButtonVariant = "secondary", size: "sm" | "md" = "sm") {
  return cn(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium transition-colors",
    "disabled:pointer-events-none disabled:opacity-40",
    size === "sm" ? "px-[11px] py-[5px] text-[12.5px]" : "px-3.5 py-[7px] text-[13px]",
    buttonVariants[variant],
  );
}

export function Button({
  variant = "secondary",
  size = "sm",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return <button type={type} className={cn(buttonClass(variant, size), className)} {...props} />;
}
