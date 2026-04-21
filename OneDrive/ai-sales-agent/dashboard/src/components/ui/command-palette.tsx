/**
 * CommandPalette — global ⌘K navigator + quick actions.
 *
 * Uses `cmdk` for the fuzzy-search input + list, and our Dialog primitive
 * for the modal shell. Exports a `useCommandPalette()` hook that returns
 * `{open, setOpen}` plus a one-liner to bind the keyboard shortcut.
 */
import { Command } from 'cmdk';
import {
  BarChart3,
  LayoutDashboard,
  Moon,
  PlusCircle,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Users,
} from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { cn } from '../../lib/cn';
import { useTheme } from '../../lib/theme';

import { Dialog, DialogContent } from './dialog';

/* ── Hook ─────────────────────────────────────────────────── */
export function useCommandPalette(): {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
} {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return { open, setOpen };
}

/* ── Component ─────────────────────────────────────────────── */
interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({
  open,
  onOpenChange,
}: CommandPaletteProps): React.ReactElement {
  const navigate = useNavigate();
  const { toggle } = useTheme();

  const go = React.useCallback(
    (to: string) => {
      navigate(to);
      onOpenChange(false);
    },
    [navigate, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'p-0 overflow-hidden max-w-xl',
          '[&>button:last-child]:hidden', // hide the default X close
        )}
      >
        <Command
          label="Command palette"
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground"
        >
          <div className="flex items-center border-b border-border/60 px-4">
            <Sparkles className="mr-2 h-4 w-4 text-primary" />
            <Command.Input
              placeholder="Type a command or search…"
              className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
            <kbd className="kbd">ESC</kbd>
          </div>
          <Command.List className="max-h-[400px] overflow-y-auto overflow-x-hidden p-2">
            <Command.Empty className="py-8 text-center text-sm text-muted-foreground">
              No results found.
            </Command.Empty>

            <Command.Group heading="Navigate">
              <PaletteItem
                icon={LayoutDashboard}
                label="Overview"
                onSelect={() => go('/')}
              />
              <PaletteItem
                icon={Sparkles}
                label="Campaigns"
                onSelect={() => go('/campaigns')}
              />
              <PaletteItem
                icon={Users}
                label="Prospects"
                onSelect={() => go('/prospects')}
              />
              <PaletteItem
                icon={BarChart3}
                label="Analytics"
                onSelect={() => go('/analytics')}
              />
              <PaletteItem
                icon={SettingsIcon}
                label="Settings"
                onSelect={() => go('/settings')}
              />
            </Command.Group>

            <Command.Group heading="Actions">
              <PaletteItem
                icon={PlusCircle}
                label="New campaign"
                shortcut="N"
                onSelect={() => go('/campaigns/new')}
              />
              <PaletteItem
                icon={Sun}
                label="Toggle theme"
                shortcut="T"
                onSelect={() => {
                  toggle();
                  onOpenChange(false);
                }}
              />
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function PaletteItem({
  icon: Icon,
  label,
  shortcut,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={label}
      onSelect={onSelect}
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm cursor-pointer aria-selected:bg-accent/70 aria-selected:text-accent-foreground transition-colors"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      {shortcut && <kbd className="kbd">{shortcut}</kbd>}
    </Command.Item>
  );
}

/* Re-export the Moon icon so callers can display it in their own palette
 * buttons without importing lucide directly. */
export { Moon };
