/**
 * Settings › Team (SaaS phase 3, slice 3.6). Owners and admins invite
 * colleagues, change roles, remove people and hand out password-reset
 * links. Invitation and reset links are always shown here (and also
 * emailed when the server can email) so they can be passed on directly.
 * Admins manage members and viewers; only owners manage admins; owners
 * are never changed here.
 */

import { Copy, KeyRound, Loader2, MailPlus, ShieldCheck, Trash2, Users } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { label } from '../lib/labels';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { PageHeader } from '../components/ui/page-header';
import {
  type LinkResult,
  type TeamMember,
  type TeamRole,
  useChangeRole,
  useInvite,
  useRemoveMember,
  useResetLink,
  useRevokeInvite,
  useTeam,
  useTransferOwnership,
} from '../hooks/useTeam';
import { errorMessage, useAuth } from '../lib/authContext';
import { locale, t, tServer } from '../i18n';

const ROLE_HELP: Record<TeamRole, string> = {
  admin: t('Manages the team, accounts and campaigns'),
  member: t('Runs campaigns, imports lists, edits the profile'),
  viewer: t('Can look, not change'),
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function Team(): React.ReactElement {
  const { user } = useAuth();
  const allowed = !user?.role || user.role === 'owner' || user.role === 'admin';
  const { data, isLoading, error } = useTeam(allowed);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t('Settings')}
        title={t('Team')}
        description={t('Invite colleagues and choose what each of them can do. Changes apply immediately.')}
        icon={Users}
      />
      {!allowed ? (
        <p className="text-sm text-muted-foreground">{t('Only owners and admins can manage the team.')}</p>
      ) : isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t('Loading')} /></div>
      ) : error || !data ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage(error, t('Could not load your team.'))}</p>
      ) : (
        <div className="max-w-4xl space-y-6">
          <InviteCard roles={data.can_invite_roles} emailEnabled={data.email_enabled} />
          <Members members={data.members} manageable={data.can_invite_roles} emailEnabled={data.email_enabled} />
          <PendingInvites />
          {user?.role === 'owner' && <TransferOwnership members={data.members} />}
        </div>
      )}
    </div>
  );
}

function CopyLink({ result, what }: { result: LinkResult; what: string }): React.ReactElement {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        {result.emailed ? t('We emailed this link.') : result.email_error ? `${tServer(result.email_error)}.` : t('Email isn\'t set up on this server, so send this link yourself.')}{' '}
        {t('It works once.')}
      </p>
      <div className="flex gap-2">
        <input readOnly aria-label={t('{what} link', { what })} className="input font-mono text-xs" value={result.link} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn-secondary shrink-0"
          onClick={() => navigator.clipboard.writeText(result.link).then(() => toast.success(t('Link copied')), () => toast.error(t('Could not copy; select it and copy by hand')))}>
          <Copy className="h-4 w-4" aria-hidden="true" />{' '}{t('Copy')}
        </button>
      </div>
    </div>
  );
}

function InviteCard({ roles, emailEnabled }: { roles: TeamRole[]; emailEnabled: boolean }): React.ReactElement {
  const invite = useInvite();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<TeamRole>(roles.includes('member') ? 'member' : roles[0]);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<(LinkResult & { to: string }) | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setResult(null);
    try {
      const r = await invite.mutateAsync({ email: email.trim(), role });
      setResult({ ...r, to: email.trim() });
      setEmail('');
    } catch (err) {
      setError(errorMessage(err, t('Could not create the invitation.')));
    }
  }

  return (
    <section className="glass rounded-2xl p-5" aria-labelledby="team-invite">
      <h2 id="team-invite" className="mb-1 flex items-center gap-2 text-base font-semibold"><MailPlus className="h-4 w-4 text-primary" aria-hidden="true" />{' '}{t('Invite someone')}</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        {emailEnabled ? t('They get a link to join this company by email.') : t('They get a link to join this company.')} {t('Inviting the same address again replaces the old link.')}
      </p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="tm-email" className="label">{t('Work email')}</label>
          <input id="tm-email" type="email" required className="input" placeholder="colleague@company.com" value={email}
            onChange={(e) => setEmail(e.target.value)} disabled={invite.isPending} />
        </div>
        <div>
          <label htmlFor="tm-role" className="label">{t('Role')}</label>
          <select id="tm-role" className="input" value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
            {roles.map((r) => <option key={r} value={r}>{label(r)}</option>)}
          </select>
        </div>
        <button type="submit" className="btn-primary" disabled={invite.isPending || !email.trim()}>
          {invite.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {t('Send invitation')}
        </button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">{ROLE_HELP[role]}.</p>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {result && (
        <div className="mt-4 rounded-xl border border-border/70 bg-card/50 p-4">
          <p className="mb-2 text-sm font-medium">{t('Invitation for {to}', { to: result.to })}</p>
          <CopyLink result={result} what="invitation" />
        </div>
      )}
    </section>
  );
}

function Members({ members, manageable, emailEnabled }: { members: TeamMember[]; manageable: TeamRole[]; emailEnabled: boolean }): React.ReactElement {
  const changeRole = useChangeRole();
  const remove = useRemoveMember();
  const resetLink = useResetLink();
  const [removing, setRemoving] = React.useState<TeamMember | null>(null);
  const [link, setLink] = React.useState<{ name: string; result: LinkResult } | null>(null);

  async function onRole(m: TeamMember, role: TeamRole) {
    try {
      await changeRole.mutateAsync({ userId: m.user_id, role });
      toast.success(t('{name}: role changed to {role}', { name: m.full_name ?? m.email, role: t(role) }));
    } catch (e) {
      toast.error(errorMessage(e, t('Could not change the role.')));
    }
  }

  async function onReset(m: TeamMember) {
    try {
      setLink({ name: m.full_name ?? m.email, result: await resetLink.mutateAsync(m.user_id) });
    } catch (e) {
      toast.error(errorMessage(e, t('Could not create a reset link.')));
    }
  }

  return (
    <section className="glass rounded-2xl p-5" aria-labelledby="team-members">
      <h2 id="team-members" className="mb-4 flex items-center gap-2 text-base font-semibold"><ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />{' '}{t('People ({count})', { count: members.length })}</h2>
      <ul className="divide-y divide-border/50">
        {members.map((m) => {
          const canManage = !m.is_you && m.role !== 'owner' && manageable.includes(m.role as TeamRole);
          return (
            <li key={m.user_id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {m.full_name ?? m.email}{m.is_you && <span className="ms-2 text-xs font-normal text-muted-foreground">{t('(you)')}</span>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {m.full_name ? `${m.email} · ` : ''}{t('last sign-in {date}', { date: when(m.last_login_at) })}{!m.email_verified && emailEnabled ? ` · ${t('email not verified')}` : ''}
                </div>
              </div>
              {canManage ? (
                <select aria-label={t('Role for {value}', { value: m.full_name ?? m.email })} className="input w-auto py-1.5 text-sm" value={m.role}
                  onChange={(e) => onRole(m, e.target.value as TeamRole)} disabled={changeRole.isPending}>
                  {manageable.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                </select>
              ) : (
                <span className="rounded-full bg-muted px-3 py-1 text-xs font-medium">{label(m.role)}</span>
              )}
              {canManage && (
                <div className="flex gap-1">
                  <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => onReset(m)} disabled={resetLink.isPending}>
                    <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />{' '}{t('Reset password')}
                  </button>
                  <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs text-destructive" onClick={() => setRemoving(m)} aria-label={t('Remove {value}', { value: m.full_name ?? m.email })}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{' '}{t('Remove')}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Remove {value}?', { value: removing?.full_name ?? removing?.email })}</DialogTitle>
            <DialogDescription>
              {t('They lose access to this company right away, on every device. Their account stays, and they can be invited again.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setRemoving(null)}>{t('Keep them')}</button>
            <button type="button" className="btn bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync(removing!.user_id);
                  toast.success(t('Removed from the team'));
                  setRemoving(null);
                } catch (e) {
                  toast.error(errorMessage(e, t('Could not remove them.')));
                }
              }}>
              {remove.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{' '}{t('Remove')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Password reset for {name}', { name: link?.name })}</DialogTitle>
            <DialogDescription>{t('Anyone with this link can set their password, so only share it with them.')}</DialogDescription>
          </DialogHeader>
          {link && <CopyLink result={link.result} what="reset" />}
          <DialogFooter><button type="button" className="btn-secondary" onClick={() => setLink(null)}>{t('Done')}</button></DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TransferOwnership({ members }: { members: TeamMember[] }): React.ReactElement | null {
  const { refresh } = useAuth();
  const transfer = useTransferOwnership();
  const candidates = members.filter((m) => !m.is_you && m.role !== 'owner');
  const [userId, setUserId] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const chosen = candidates.find((m) => m.user_id === userId);
  if (!candidates.length) return null;

  async function onConfirm() {
    setError(null);
    try {
      const r = await transfer.mutateAsync({ userId, password });
      toast.success(t('{email} is now the owner', { email: r.new_owner.email }), { description: t('You are an admin now.') });
      setConfirming(false);
      setPassword('');
      setUserId('');
      await refresh();
    } catch (e) {
      setError(errorMessage(e, t('Could not transfer ownership.')));
    }
  }

  return (
    <section className="glass rounded-2xl p-5" aria-labelledby="team-transfer">
      <h2 id="team-transfer" className="mb-1 text-base font-semibold">{t('Transfer ownership')}</h2>
      <p className="mb-4 text-xs text-muted-foreground">
        {t('Hand this company to someone in your team. They become the owner and you become an admin. Only the owner can do this, and you confirm with your password.')}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="to-person" className="label">{t('New owner')}</label>
          <select id="to-person" className="input" value={userId} onChange={(e) => { setUserId(e.target.value); setError(null); }}>
            <option value="">{t('Choose someone')}</option>
            {candidates.map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name ?? m.email} ({label(m.role)})</option>)}
          </select>
        </div>
        <button type="button" className="btn-secondary" disabled={!userId} onClick={() => setConfirming(true)}>{t('Transfer…')}</button>
      </div>
      <Dialog open={confirming} onOpenChange={(o) => { setConfirming(o); if (!o) setError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Make {value} the owner?', { value: chosen?.full_name ?? chosen?.email })}</DialogTitle>
            <DialogDescription>
              {t('They get full control of this company, including connected accounts and the team. You\'ll be an admin and can\'t undo this yourself. Type your password to confirm.')}
            </DialogDescription>
          </DialogHeader>
          <div>
            <label htmlFor="to-password" className="label">{t('Your password')}</label>
            <input id="to-password" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>{t('Cancel')}</button>
            <button type="button" className="btn bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={!password || transfer.isPending} onClick={onConfirm}>
              {transfer.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}{' '}{t('Transfer ownership')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PendingInvites(): React.ReactElement | null {
  const { data } = useTeam();
  const revoke = useRevokeInvite();
  if (!data?.invites.length) return null;
  return (
    <section className="glass rounded-2xl p-5" aria-labelledby="team-pending">
      <h2 id="team-pending" className="mb-4 text-base font-semibold">{t('Waiting to join ({count})', { count: data.invites.length })}</h2>
      <ul className="divide-y divide-border/50">
        {data.invites.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{i.email}</div>
              <div className="text-xs text-muted-foreground">
                {t(i.role)}{i.invited_by_name ? ` · ${t('invited by {name}', { name: i.invited_by_name })}` : ''} · {t('expires {date}', { date: when(i.expires_at) })}
              </div>
            </div>
            <button type="button" className="btn-ghost px-2.5 py-1.5 text-xs" disabled={revoke.isPending}
              onClick={async () => {
                try {
                  await revoke.mutateAsync(i.id);
                  toast.success(t('Invitation withdrawn'));
                } catch (e) {
                  toast.error(errorMessage(e, t('Could not withdraw it.')));
                }
              }}>
              {t('Withdraw')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
