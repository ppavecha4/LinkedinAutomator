/**
 * Breadcrumb — sleek top-bar breadcrumb. Auto-generates from the current
 * pathname via `useBreadcrumbs()` which reads the NAV table passed to it.
 */
import { ChevronRight } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';

import { cn } from '../../lib/cn';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumb({
  items,
  className,
}: BreadcrumbProps): React.ReactElement {
  return (
    <nav aria-label="breadcrumb" className={cn('flex items-center', className)}>
      <ol className="flex items-center gap-1.5 text-sm">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={i} className="flex items-center gap-1.5">
              {item.href && !last ? (
                <Link
                  to={item.href}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  className={cn(
                    last
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground',
                  )}
                  aria-current={last ? 'page' : undefined}
                >
                  {item.label}
                </span>
              )}
              {!last && (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
