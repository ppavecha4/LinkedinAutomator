/**
 * Settings › Privacy requests (SaaS phase 6). When a person asks what the
 * company holds about them, or asks to be deleted, an owner or admin does it
 * here: download everything held as a file, or erase it. Erasing removes
 * their messages, conversations and meetings and keeps only a do-not-contact
 * entry so nobody contacts them again.
 */

import { Download, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import * as React from 'react';
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
import { api } from '../lib/api';
import { errorMessage, useAuth } from '../lib/authContext';

interface ExportResult {
  found: boolean;
  data: Record<string, unknown[]>;
}

type Counts = Record<string, number>;

const LABELS: Record<string, string> = {
  contacts: 'contact records', messages: 'messages', conversations: 'conversations', meetings: 'meetings',
  events: 'timeline events', import_rows: 'uploaded rows', webhook_events: 'received events',
};

export default function Privacy(): React.ReactElement {
  const { user } = useAuth();
  const allowed = !user?.role || user.role === 'owner' || user.role === 'admin';
  const [email, setEmail] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [busy, setBusy] = React.useState<'export' | 'erase' | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [result, setResult] = React.useState<{ kind: 'export'; found: boolean; counts: Counts } | { kind: 'erase'; counts: Counts } | null>(null);

  const who = { ...(email.trim() ? { email: email.trim() } : {}), ...(phone.trim() ? { whatsapp: phone.trim() } : {}) };
  const ready = Object.keys(who).length > 0;

  async function doExport(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy('export');
    setResult(null);
    try {
      const { data } = await api.post<ExportResult>('/api/privacy/export', who);
      const counts: Counts = Object.fromEntries(Object.entries(data.data).map(([k, v]) => [k, v.length]));
      setResult({ kind: 'export', found: data.found, counts });
      if (data.found) {
        const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'data-held-about-this-person.json';
        a.click();
        URL.revokeObjectURL(a.href);
      }
    } catch (err) {
      toast.error(errorMessage(err, 'Could not look that person up.'));
    } finally {
      setBusy(null);
    }
  }

  async function doErase() {
    setBusy('erase');
    try {
      const { data } = await api.post<Counts>('/api/privacy/erase', { ...who, confirm: true });
      setResult({ kind: 'erase', counts: data });
      setConfirming(false);
      setEmail('');
      setPhone('');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not erase that person.'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Settings"
        title="Privacy requests"
        description="When someone asks what you hold about them, or asks you to delete it, handle it here."
        icon={ShieldCheck}
      />
      {!allowed ? (
        <p className="text-sm text-muted-foreground">Only owners and admins can handle privacy requests.</p>
      ) : (
        <form onSubmit={doExport} className="glass max-w-3xl space-y-5 rounded-2xl p-6" aria-labelledby="priv-title">
          <h2 id="priv-title" className="text-base font-semibold">Find a person</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="priv-email">Email address</label>
              <input id="priv-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@company.com" autoComplete="off" />
            </div>
            <div>
              <label className="label" htmlFor="priv-phone">WhatsApp number</label>
              <input id="priv-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+51 987 654 321" autoComplete="off" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Either one is enough. Only your own company's records are searched.</p>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn-primary" disabled={!ready || busy !== null}>
              {busy === 'export' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
              Download their data
            </button>
            <button type="button" className="btn-secondary text-destructive" disabled={!ready || busy !== null} onClick={() => setConfirming(true)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Erase their data…
            </button>
          </div>

          {result?.kind === 'export' && (
            <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              {result.found
                ? `Downloaded: ${Object.entries(result.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${LABELS[k] ?? k}`).join(', ') || 'a do-not-contact entry'}.`
                : 'You hold nothing about that person.'}
            </p>
          )}
          {result?.kind === 'erase' && (
            <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
              Erased: {Object.entries(result.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${LABELS[k] ?? k}`).join(', ') || 'nothing was held'}.
              They are on your do-not-contact list so nobody contacts them again.
            </p>
          )}
        </form>
      )}

      <Dialog open={confirming} onOpenChange={(o) => !o && busy === null && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Erase everything about this person?</DialogTitle>
            <DialogDescription>
              Their messages, conversations, meetings and timeline are deleted and their contact record is blanked.
              This cannot be undone. A do-not-contact entry stays, so they are never contacted again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)} disabled={busy !== null}>Cancel</button>
            <button type="button" className="btn-primary" onClick={doErase} disabled={busy !== null}>
              {busy === 'erase' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Erase
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
