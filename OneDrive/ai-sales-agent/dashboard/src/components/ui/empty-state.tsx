/**
 * EmptyState — standard "no content yet" card used by every list view.
 *
 *   <EmptyState
 *     icon={Inbox}
 *     title="No campaigns yet"
 *     description="Kick off your first outbound run."
 *     action={<Link to="/campaigns/new" className="btn-primary">Create</Link>}
 *   />
 *
 * Visual signature: dot-grid background with a radial mask, gradient icon
 * chip, restrained copy, centered CTA.
 */
import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'relative glass rounded-2xl overflow-hidden',
        'flex flex-col items-center justify-center text-center',
        'py-16 px-6',
        className,
      )}
    >
      {/* Dot-grid backdrop with radial mask */}
      <div
        className="absolute inset-0 bg-grid-subtle pointer-events-none"
        style={{
          maskImage:
            'radial-gradient(ellipse at center, black 30%, transparent 70%)',
          WebkitMaskImage:
            'radial-gradient(ellipse at center, black 30%, transparent 70%)',
        }}
      />
      <div className="relative inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-lg shadow-primary/30">
        <Icon className="h-7 w-7" />
      </div>
      <div className="relative mt-5 text-base font-semibold text-foreground">
        {title}
      </div>
      {description && (
        <div className="relative mt-1.5 text-sm text-muted-foreground max-w-sm">
          {description}
        </div>
      )}
      {action && <div className="relative mt-6">{action}</div>}
    </div>
  );
}
