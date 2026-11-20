/**
 * AI phone calls (voice channel). Start calls for a campaign, watch them, read
 * the transcripts. We only call people who agreed to calls or who already
 * replied to us: the company confirms consent here, in writing, and the voice
 * server re-checks every rule (consent, do-not-contact list, the person's
 * local hours) right before it dials.
 */

import { Loader2, Phone, PhoneCall } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { PageHeader } from '../components/ui/page-header';
import { type CallRow, useCall, useCalls, useCancelCall, useConfirmConsent, useEligibility, useQueueCalls } from '../hooks/useCalls';
import { useCampaigns } from '../hooks/useCampaigns';
import { useCredentials } from '../hooks/useWorkspace';
import { errorMessage, useAuth } from '../lib/authContext';
import { cn } from '../lib/cn';
import { verifiedFor } from '../lib/workspace';

const STATUS: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: 'Waiting', tone: 'bg-muted text-muted-foreground' },
  DIALING: { label: 'Ringing', tone: 'bg-amber-500/15 text-amber-600' },
  IN_PROGRESS: { label: 'On the phone', tone: 'bg-primary/15 text-primary' },
  COMPLETED: { label: 'Done', tone: 'bg-emerald-500/15 text-emerald-600' },
  NO_ANSWER: { label: 'No answer', tone: 'bg-muted text-muted-foreground' },
  BUSY: { label: 'Busy', tone: 'bg-muted text-muted-foreground' },
  VOICEMAIL: { label: 'Voicemail', tone: 'bg-muted text-muted-foreground' },
  FAILED: { label: 'Failed', tone: 'bg-destructive/15 text-destructive' },
  BLOCKED: { label: 'Not allowed', tone: 'bg-destructive/15 text-destructive' },
  CANCELLED: { label: 'Cancelled', tone: 'bg-muted text-muted-foreground' },
};

const OUTCOME: Record<string, string> = {
  INTERESTED: 'Interested', NOT_INTERESTED: 'Not interested', CALLBACK: 'Wants a call later',
  OPT_OUT: 'Asked not to be called', WRONG_PERSON: 'Wrong person', NO_CONVERSATION: 'No conversation',
};

const SKIP_LABEL: Record<string, string> = {
  no_phone: 'no valid phone number', suppressed: 'on your do-not-contact list', not_contactable: 'unsubscribed or disqualified',
  no_basis: 'have not agreed to calls', already_called: 'called recently or waiting',
};

const fmtDuration = (s: number | null) => (s == null ? '—' : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
const fmtWhen = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export default function Calls(): React.ReactElement {
  const { user } = useAuth();
  const canWrite = !user?.role || ['owner', 'admin', 'member'].includes(user.role);
  const creds = useCredentials();
  const [open, setOpen] = React.useState<string | null>(null);
  const calls = useCalls();

  const ready = !!verifiedFor(creds.data, ['elevenlabs']) && !!verifiedFor(creds.data, ['anthropic']) && (creds.data ?? []).some(
    (c) => c.provider === 'twilio' && c.status === 'VERIFIED' && String((c.meta as Record<string, unknown>)?.voice_from ?? '').trim() !== '');

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Workspace"
        title="AI phone calls"
        description="An automated assistant calls people who agreed to calls or who already replied to you, and tells you how it went."
        icon={Phone}
      />
      {!creds.isLoading && !ready && (
        <p role="status" className="max-w-3xl rounded-xl border border-border bg-muted/40 p-4 text-sm">
          To make calls, connect your ElevenLabs account (the voice), a phone number for calls in your Twilio account, and your AI key.{' '}
          <Link to="/settings/connections" className="font-semibold text-primary underline">Connected accounts</Link>
        </p>
      )}
      {canWrite && ready && <StartCalls />}
      <section className="glass max-w-5xl rounded-2xl p-6" aria-labelledby="calls-title">
        <h2 id="calls-title" className="mb-4 text-base font-semibold">Recent calls</h2>
        {calls.isLoading ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
        ) : !calls.data?.length ? (
          <p className="text-sm text-muted-foreground">No calls yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-muted-foreground">
                  <th className="pb-2 pr-4 font-medium">Person</th><th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Result</th><th className="pb-2 pr-4 font-medium">Length</th>
                  <th className="pb-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {calls.data.map((c) => <Row key={c.id} call={c} onOpen={() => setOpen(c.id)} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Transcript id={open} onClose={() => setOpen(null)} canWrite={canWrite} />
    </div>
  );
}

function Row({ call: c, onOpen }: { call: CallRow; onOpen: () => void }): React.ReactElement {
  const s = STATUS[c.status] ?? { label: c.status, tone: 'bg-muted' };
  return (
    <tr className="cursor-pointer hover:bg-muted/40" onClick={onOpen}>
      <td className="py-2.5 pr-4">
        <button type="button" className="text-left font-medium hover:underline" onClick={onOpen}>{c.contact_name ?? c.to_number ?? 'Unknown'}</button>
        <div className="text-xs text-muted-foreground">{c.company_name ?? ''}</div>
      </td>
      <td className="py-2.5 pr-4"><span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', s.tone)}>{s.label}</span></td>
      <td className="py-2.5 pr-4 text-muted-foreground">{c.outcome ? OUTCOME[c.outcome] ?? c.outcome : c.failure_reason ?? '—'}</td>
      <td className="py-2.5 pr-4 text-muted-foreground">{fmtDuration(c.duration_seconds)}</td>
      <td className="py-2.5 text-muted-foreground">{fmtWhen(c.created_at)}</td>
    </tr>
  );
}

function StartCalls(): React.ReactElement {
  const campaigns = useCampaigns();
  const voice = (campaigns.data ?? []).filter((c) => ((c as unknown as { channels?: string[] }).channels ?? []).includes('voice') && c.status === 'ACTIVE');
  const [campaign, setCampaign] = React.useState('');
  const [attest, setAttest] = React.useState(false);
  const id = campaign || voice[0]?.id;
  const elig = useEligibility(id);
  const queue = useQueueCalls();
  const consent = useConfirmConsent();

  async function start() {
    if (!id) return;
    try {
      const r = await queue.mutateAsync(id);
      toast.success(r.queued === 0 ? 'Nobody new to call.' : `${r.queued} call${r.queued === 1 ? '' : 's'} queued.`, {
        description: 'Calls go out one by one, within each person’s own contact hours.',
      });
    } catch (e) {
      toast.error(errorMessage(e, 'Could not queue the calls.'));
    }
  }

  async function confirmConsent() {
    if (!id) return;
    try {
      const r = await consent.mutateAsync(id);
      toast.success(`${r.marked} ${r.marked === 1 ? 'person' : 'people'} marked as agreed to calls.`);
      setAttest(false);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not save that.'));
    }
  }

  if (campaigns.isLoading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (voice.length === 0) {
    return (
      <p className="max-w-3xl text-sm text-muted-foreground">
        No launched campaign uses AI phone calls yet. Create a campaign and choose “AI phone calls” as a channel, then launch it.{' '}
        <Link to="/campaigns/new" className="font-semibold text-primary underline">New campaign</Link>
      </p>
    );
  }
  const e = elig.data;
  return (
    <section className="glass max-w-3xl space-y-4 rounded-2xl p-6" aria-labelledby="start-title">
      <h2 id="start-title" className="text-base font-semibold">Start calls</h2>
      <div>
        <label className="label" htmlFor="call-campaign">Campaign</label>
        <select id="call-campaign" className="input" value={id ?? ''} onChange={(ev) => { setCampaign(ev.target.value); setAttest(false); }}>
          {voice.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {elig.isLoading || !e ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
      ) : (
        <>
          <p className="text-sm"><span className="font-semibold">{e.eligible}</span> {e.eligible === 1 ? 'person is' : 'people are'} ready to call.</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {(['no_basis', 'no_phone', 'suppressed', 'not_contactable', 'already_called'] as const).filter((k) => e[k] > 0).map((k) => (
              <li key={k}>{e[k]} {SKIP_LABEL[k]}</li>
            ))}
          </ul>
          {e.no_basis > 0 && (
            <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-4">
              <p className="text-sm">{e.no_basis} {e.no_basis === 1 ? 'person has' : 'people have'} not agreed to calls yet, so they will not be called.</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={attest} onChange={(ev) => setAttest(ev.target.checked)} />
                <span>I confirm these people agreed to receive AI phone calls from us. I am responsible for that consent.</span>
              </label>
              <button type="button" className="btn-secondary" disabled={!attest || consent.isPending} onClick={confirmConsent}>
                {consent.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Confirm consent
              </button>
            </div>
          )}
          <button type="button" className="btn-primary" disabled={e.eligible === 0 || queue.isPending} onClick={start}>
            {queue.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <PhoneCall className="h-4 w-4" aria-hidden="true" />}
            Queue {e.eligible} call{e.eligible === 1 ? '' : 's'}
          </button>
        </>
      )}
    </section>
  );
}

function Transcript({ id, onClose, canWrite }: { id: string | null; onClose: () => void; canWrite: boolean }): React.ReactElement {
  const { data, isLoading } = useCall(id);
  const cancel = useCancelCall();
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{data?.contact_name ?? 'Call'}</DialogTitle>
          <DialogDescription>
            {data ? `${STATUS[data.status]?.label ?? data.status}${data.outcome ? ` · ${OUTCOME[data.outcome] ?? data.outcome}` : ''} · ${fmtDuration(data.duration_seconds)}` : ''}
          </DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
        ) : (
          <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {data.summary && <p className="text-sm text-muted-foreground">{data.summary}</p>}
            {data.failure_reason && data.status !== 'COMPLETED' && <p className="text-sm text-destructive">{data.failure_reason}</p>}
            {data.transcript.length === 0 && <p className="text-sm text-muted-foreground">No conversation was recorded.</p>}
            {data.transcript.map((t, i) => (
              <div key={i} className={cn('flex', t.who === 'agent' ? 'justify-start' : 'justify-end')}>
                <p className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm', t.who === 'agent' ? 'bg-muted' : 'bg-primary/15')}>
                  <span className="mb-0.5 block text-[10px] font-semibold uppercase text-muted-foreground">{t.who === 'agent' ? 'Assistant' : 'Them'}{t.interrupted ? ' · interrupted' : ''}</span>
                  {t.text}
                </p>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          {canWrite && data?.status === 'QUEUED' && (
            <button type="button" className="btn-secondary" disabled={cancel.isPending}
              onClick={async () => { try { await cancel.mutateAsync(data.id); onClose(); } catch (e) { toast.error(errorMessage(e, 'Could not cancel.')); } }}>
              Cancel this call
            </button>
          )}
          <button type="button" className="btn-primary" onClick={onClose}>Close</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
