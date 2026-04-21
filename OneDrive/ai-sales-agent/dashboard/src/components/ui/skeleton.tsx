/**
 * Skeleton — shadcn-style loading placeholder. Pulse animation, token-aware.
 */
import * as React from 'react';

import { cn } from '../../lib/cn';

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted/70', className)}
      {...props}
    />
  );
}
