/**
 * `cn()` — the shadcn/ui convention helper.
 *
 * `clsx` handles conditional class names, `twMerge` collapses duplicate
 * Tailwind utilities (so a user-provided `className="bg-red-500"` can
 * override a component default of `bg-primary` without fighting the
 * cascade). Use this anywhere components accept external `className`.
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
