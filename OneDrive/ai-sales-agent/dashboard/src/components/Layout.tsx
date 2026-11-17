/**
 * Top-level layout — collapsible glass sidebar + sticky topbar with
 * breadcrumbs + ⌘K command palette + avatar dropdown + aurora background.
 *
 * Interactions:
 *   - Sidebar: click the chevron or press ⌘B to collapse (persisted)
 *   - ⌘K: open command palette
 *   - ⌘B: toggle sidebar
 *
 * Information architecture:
 *   NAV[] is the single source of truth for routes + breadcrumbs + the
 *   command palette. The top bar reads it to build the breadcrumb trail;
 *   the palette reads it to populate the "Navigate" group.
 */

import { motion } from 'framer-motion';
import {
  ArrowRight,
  BarChart3,
  Building2,
  Check,
  ChevronsLeft,
  Command,
  HelpCircle,
  Inbox,
  LayoutDashboard,
  Loader2,
  Briefcase,
  LogOut,
  Moon,
  PanelLeft,
  Plug,
  PlusCircle,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  User,
  Users,
  Wand2,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useOrganization } from '../hooks/useWorkspace';
import { api } from '../lib/api';
import { errorMessage, type Membership, useAuth } from '../lib/authContext';
import { cn } from '../lib/cn';
import { useSidebarCollapse } from '../lib/sidebar';
import { useTheme } from '../lib/theme';
import { Avatar, AvatarFallback } from './ui/avatar';
import { Breadcrumb } from './ui/breadcrumb';
import { Button } from './ui/button';
import {
  CommandPalette,
  useCommandPalette,
} from './ui/command-palette';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Separator } from './ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface NavItem {
  to: string;
  label: string;
  end: boolean;
  icon: LucideIcon;
  section?: string;
  /** Only the operator (Appson) workspace has this feature. */
  operatorOnly?: boolean;
  /** Owners and admins only (not shown to members and viewers). */
  managerOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', end: true, icon: LayoutDashboard, section: 'Workspace' },
  { to: '/campaigns', label: 'Campaigns', end: false, icon: Sparkles, section: 'Workspace' },
  { to: '/campaigns/plan', label: 'Plan with AI', end: true, icon: Wand2, section: 'Workspace', operatorOnly: true },
  { to: '/prospects', label: 'Prospects', end: false, icon: Users, section: 'Workspace' },
  { to: '/inbox', label: 'Inbox', end: false, icon: Inbox, section: 'Workspace' },
  { to: '/linkedin-drafts', label: 'LinkedIn Drafts', end: false, icon: Briefcase, section: 'Operator', operatorOnly: true },
  { to: '/analytics', label: 'Analytics', end: false, icon: BarChart3, section: 'Insights' },
  { to: '/settings/profile', label: 'Business profile', end: true, icon: Building2, section: 'Account' },
  { to: '/settings/connections', label: 'Connected accounts', end: true, icon: Plug, section: 'Account' },
  { to: '/settings/team', label: 'Team', end: true, icon: Users, section: 'Account', managerOnly: true },
  { to: '/settings', label: 'Settings', end: true, icon: SettingsIcon, section: 'Account' },
];

/** Resolve the active NAV entry, handling `/campaigns/new` → `/campaigns`. */
function resolveCurrent(pathname: string): NavItem {
  // Longest-prefix match.
  const matches = NAV.filter((n) =>
    n.end ? pathname === n.to : pathname.startsWith(n.to),
  ).sort((a, b) => b.to.length - a.to.length);
  return matches[0] ?? NAV[0];
}

/** Build breadcrumb items from pathname. */
function buildBreadcrumbs(pathname: string): { label: string; href?: string }[] {
  const current = resolveCurrent(pathname);
  const trail: { label: string; href?: string }[] = [
    { label: 'Home', href: '/' },
  ];
  if (current.to !== '/') {
    trail.push({ label: current.label, href: current.to });
  }
  if (pathname.startsWith('/campaigns/new')) {
    trail.push({ label: 'New campaign' });
  } else if (/^\/campaigns\/[^/]+\/import$/.test(pathname)) {
    trail.push({ label: 'Upload a list' });
  }
  return trail;
}

export default function Layout(): React.ReactElement {
  const { resolvedTheme, toggle: toggleTheme } = useTheme();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { logout, user, org, bypassMode, needsOnboarding, switchOrg, emailEnabled } = useAuth();
  const [resending, setResending] = React.useState(false);
  const needsVerification = emailEnabled && !bypassMode && user?.email_verified === false;
  async function resendVerification() {
    setResending(true);
    try {
      await api.post('/api/auth/resend-verification');
      toast.success('Verification email sent', { description: `Check ${user?.email}.` });
    } catch (e) {
      toast.error(errorMessage(e, 'Could not send the email.'));
    } finally {
      setResending(false);
    }
  }
  // Companies this person belongs to (local auth only), for the switcher.
  const { data: orgs } = useQuery({
    queryKey: ['auth', 'orgs', user?.uid],
    queryFn: async () => (await api.get<Membership[]>('/api/auth/orgs')).data,
    enabled: !bypassMode && !!user?.uid,
    staleTime: 60_000,
  });
  const orgName = org?.name ?? (bypassMode ? 'Dev workspace' : 'Your company');
  const initials = orgName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || 'AI';
  const otherOrgs = (orgs ?? []).filter((o) => o.org_id !== user?.org_id);
  const { collapsed, toggle: toggleSidebar } = useSidebarCollapse();
  const palette = useCommandPalette();

  const current = resolveCurrent(pathname);
  const breadcrumbs = buildBreadcrumbs(pathname);

  // Operator-only entries stay hidden from customer workspaces.
  const { data: orgInfo } = useOrganization();
  const isOperator = orgInfo?.operator ?? bypassMode;
  const isManager = !user?.role || user.role === 'owner' || user.role === 'admin';

  // Group NAV by section for the sidebar.
  const grouped = React.useMemo(() => {
    const map = new Map<string, NavItem[]>();
    NAV.filter((n) => (!n.operatorOnly || isOperator) && (!n.managerOnly || isManager)).forEach((n) => {
      const key = n.section ?? 'Other';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(n);
    });
    return Array.from(map.entries());
  }, [isOperator, isManager]);

  return (
    <>
      {/* Aurora mesh — fixed, drifting, behind everything. */}
      <div className="bg-aurora">
        <span />
        <div className="bg-aurora-grid" />
      </div>

      {/* Global ⌘K palette */}
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />

      <div className="min-h-screen flex text-foreground">
        {/* ═══ Sidebar ════════════════════════════════════════════════ */}
        <motion.aside
          animate={{ width: collapsed ? 72 : 260 }}
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          className={cn(
            'shrink-0 hidden md:flex flex-col overflow-hidden',
            'glass border-r border-border/60 sticky top-0 h-screen z-30',
          )}
        >
          {/* Brand */}
          <div className="px-4 py-5 border-b border-border/60">
            <div className="flex items-center gap-3 min-w-0">
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-lg shadow-primary/40">
                <Sparkles className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500 border-2 border-background" />
                </span>
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <div className="font-semibold leading-tight truncate">
                    AI Sales Agent
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    Autonomous outbound
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ⌘K trigger */}
          <div className="p-3">
            <button
              onClick={() => palette.setOpen(true)}
              className={cn(
                'w-full flex items-center gap-2 glass rounded-lg text-xs text-muted-foreground',
                'hover:text-foreground hover:bg-card/90 transition-colors',
                collapsed ? 'justify-center py-2.5 px-0' : 'py-2 px-3',
              )}
              aria-label="Open command palette"
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left truncate">Search…</span>
                  <span className="kbd">
                    <Command className="h-2.5 w-2.5" />K
                  </span>
                </>
              )}
            </button>
          </div>

          {/* Nav grouped by section */}
          <nav className="flex-1 px-3 space-y-4 overflow-y-auto">
            {grouped.map(([section, items]) => (
              <div key={section}>
                {!collapsed && (
                  <div className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                    {section}
                  </div>
                )}
                <div className="space-y-1">
                  {items.map((item) => {
                    const Icon = item.icon;
                    const isActive = item.end
                      ? pathname === item.to
                      : pathname.startsWith(item.to);
                    const link = (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        className={cn(
                          'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all',
                          collapsed && 'justify-center px-0',
                          isActive
                            ? 'text-foreground font-medium'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {isActive && (
                          <motion.div
                            layoutId="activeNavPill"
                            className="absolute inset-0 rounded-xl bg-gradient-to-r from-primary/20 via-primary/10 to-transparent border border-primary/30 shadow-lg shadow-primary/10"
                            transition={{
                              type: 'spring',
                              stiffness: 350,
                              damping: 30,
                            }}
                          />
                        )}
                        <Icon
                          className={cn(
                            'relative h-4 w-4 shrink-0',
                            isActive ? 'text-primary' : '',
                          )}
                        />
                        {!collapsed && (
                          <span className="relative truncate">{item.label}</span>
                        )}
                      </NavLink>
                    );

                    // When collapsed, wrap in a tooltip showing the label.
                    return collapsed ? (
                      <Tooltip key={item.to}>
                        <TooltipTrigger asChild>{link}</TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    ) : (
                      link
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Footer — collapse toggle (+ a dev-mode note in auth bypass) */}
          <div className="p-3 space-y-3 border-t border-border/60">
            {!collapsed && bypassMode && (
              <div className="glass-strong rounded-xl p-3.5 gradient-border">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Zap className="h-3.5 w-3.5 text-primary" />
                  <span className="text-gradient">Dev mode</span>
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground leading-relaxed">
                  Auth bypass: no sign-in required
                </div>
              </div>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={toggleSidebar}
                  className={cn(
                    'w-full flex items-center gap-2 rounded-lg text-xs text-muted-foreground',
                    'hover:text-foreground hover:bg-accent/40 transition-colors',
                    collapsed ? 'justify-center py-2' : 'py-1.5 px-3',
                  )}
                  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                  <ChevronsLeft
                    className={cn(
                      'h-4 w-4 transition-transform',
                      collapsed && 'rotate-180',
                    )}
                  />
                  {!collapsed && <span>Collapse</span>}
                  {!collapsed && <span className="ml-auto kbd">⌘B</span>}
                </button>
              </TooltipTrigger>
              {collapsed && (
                <TooltipContent side="right">
                  Expand sidebar (⌘B)
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </motion.aside>

        {/* ═══ Main ═══════════════════════════════════════════════════ */}
        <main className="flex-1 min-w-0 flex flex-col">
          {/* Sticky top bar */}
          <header
            className={cn(
              'sticky top-0 z-20 flex h-16 items-center gap-4 px-4 md:px-8',
              'glass border-b border-border/60',
            )}
          >
            {/* Mobile sidebar toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={toggleSidebar}
              aria-label="Toggle sidebar"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>

            {/* Breadcrumb */}
            <Breadcrumb items={breadcrumbs} className="hidden sm:flex" />

            <div className="flex-1" />

            {/* Quick action: New campaign */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-9 hidden sm:inline-flex"
                  onClick={() => navigate('/campaigns/new')}
                >
                  <PlusCircle className="h-4 w-4" />
                  <span className="hidden md:inline">New campaign</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Launch a new outbound run</TooltipContent>
            </Tooltip>

            <Separator orientation="vertical" className="h-6 hidden sm:block" />

            {/* Theme toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={
                    resolvedTheme === 'dark'
                      ? 'Switch to light mode'
                      : 'Switch to dark mode'
                  }
                  onClick={toggleTheme}
                  className="rounded-full h-9 w-9"
                >
                  {resolvedTheme === 'dark' ? (
                    <Sun className="h-4 w-4" />
                  ) : (
                    <Moon className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Toggle theme</TooltipContent>
            </Tooltip>

            {/* Avatar dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-2 glass rounded-full pl-1 pr-3 py-1 hover:bg-card/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="User menu"
                >
                  <Avatar className="h-7 w-7">
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                  <span className="text-xs font-medium hidden sm:inline max-w-[10rem] truncate">
                    {orgName}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="truncate">{orgName}</div>
                  {user?.email && !bypassMode && (
                    <div className="truncate text-xs font-normal text-muted-foreground">{user.email}</div>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {otherOrgs.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Users className="h-4 w-4" />
                      Switch company
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem disabled>
                        <Check className="h-4 w-4" />
                        {orgName}
                      </DropdownMenuItem>
                      {otherOrgs.map((o) => (
                        <DropdownMenuItem
                          key={o.org_id}
                          onSelect={async () => {
                            try {
                              await switchOrg(o.org_id);
                              navigate('/', { replace: true });
                              window.location.reload(); // drop every cached query of the old company
                            } catch (e) {
                              toast.error(errorMessage(e, 'Could not switch company.'));
                            }
                          }}
                        >
                          <span className="w-4" />
                          {o.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuItem onSelect={() => navigate('/settings/profile')}>
                  <User className="h-4 w-4" />
                  Business profile
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigate('/settings')}>
                  <SettingsIcon className="h-4 w-4" />
                  Settings
                  <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => palette.setOpen(true)}>
                  <Search className="h-4 w-4" />
                  Command palette
                  <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <HelpCircle className="h-4 w-4" />
                  Help & docs
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={async () => {
                    await logout();
                    navigate('/login', { replace: true });
                  }}
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>

          {/* Page content */}
          <div className="flex-1 overflow-auto">
            <div className="mx-auto max-w-7xl px-4 md:px-8 py-8 animate-fade-in">
              {needsVerification && (
                <div role="status" className="mb-6 flex flex-col gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center">
                  <div className="flex-1 text-sm">
                    <span className="font-semibold">Verify your email address.</span>{' '}
                    <span className="text-muted-foreground">
                      We sent a link to {user?.email}. You can set everything up now, but launching a campaign needs it.
                    </span>
                  </div>
                  <button type="button" className="btn-secondary shrink-0" onClick={resendVerification} disabled={resending}>
                    {resending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Resend the link
                  </button>
                </div>
              )}
              {needsOnboarding && (
                <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/10 p-4 sm:flex-row sm:items-center">
                  <div className="flex-1 text-sm">
                    <span className="font-semibold">Finish setting up {orgName}.</span>{' '}
                    <span className="text-muted-foreground">
                      The AI needs your business profile before it can find prospects and write for you.
                    </span>
                  </div>
                  <button type="button" className="btn-primary shrink-0" onClick={() => navigate('/onboarding')}>
                    Continue setup <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              )}
              <Outlet />
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
