/**
 * PageHeader — the giant gradient title block that every page opens with.
 *
 *   <PageHeader
 *     eyebrow="Live"
 *     title="Campaigns"
 *     description="Every outbound run in flight, updated in real time."
 *     icon={Sparkles}
 *     actions={<Button>+ New</Button>}
 *   />
 *
 * Opinions:
 *   - 3xl → 4xl heading, `text-gradient` for brand presence
 *   - Eyebrow pill (tiny glass chip) for section labelling
 *   - Description in muted-foreground
 *   - Optional icon slot (renders into the same gradient background)
 *   - Actions slot pinned right
 */
import type { LucideIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  icon: Icon,
  actions,
  className,
}: PageHeaderProps): React.ReactElement {
  return (
    <div
      className={cn(
        'relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-6 pb-6 mb-6 border-b border-border/60',
        className,
      )}
    >
      <div className="flex items-start gap-4">
        {Icon && (
          <div className="shrink-0 mt-1 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-lg shadow-primary/30">
            <Icon className="h-6 w-6" />
          </div>
        )}
        <div className="min-w-0">
          {eyebrow && (
            <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-card/60 backdrop-blur px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              {eyebrow}
            </div>
          )}
          <h1 className="text-3xl sm:text-4xl font-bold leading-tight">
            <span className="text-gradient">{title}</span>
          </h1>
          {description && (
            <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
              {description}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
