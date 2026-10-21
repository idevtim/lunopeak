import type { CSSProperties } from "react";

/** Easing for every first-run setup animation. */
export const EASE = "cubic-bezier(.2,.8,.2,1)";

/**
 * Inline `animation` for one of the `lp-ob-*` keyframes in index.css. Pair
 * the element with the `lp-ob-anim` class so reduced motion skips it.
 */
export function ob(name: string, ms: number, delay = 0, easing = EASE): CSSProperties {
  return { animation: `lp-ob-${name} ${ms}ms ${easing} ${delay}ms both` };
}
