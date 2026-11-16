/**
 * AI helpers shared by onboarding and Settings › Business profile:
 * read the website into draft fields, and write a sample first message.
 * Both use the org's own Anthropic key when connected, else the
 * platform's capped onboarding allowance (the API decides).
 */

import { Globe, Loader2, Wand2 } from 'lucide-react';
import * as React from 'react';

import { useReadWebsite, useSampleMessage } from '../../hooks/useProfile';
import { errorMessage } from '../../lib/authContext';
import { countryName, type Profile } from '../../lib/profile';
import { CountrySelect, Field } from './fields';

/** Fill only what is still empty: never overwrite what the customer typed. */
export function mergeWebsiteDraft(
  cur: Profile,
  d: { company?: Profile['company']; offer?: Profile['offer'] },
  url: string,
): { next: Profile; filled: Set<string> } {
  const filled = new Set<string>();
  const company: Record<string, unknown> = { ...cur.company, website: cur.company.website || url };
  for (const [k, v] of Object.entries(d.company ?? {})) {
    const have = company[k];
    const empty = have == null || have === '' || (Array.isArray(have) && have.length === 0);
    if (empty && v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) {
      company[k] = v;
      filled.add(`company.${k}`);
    }
  }
  const offer = { ...cur.offer };
  if (!offer.offers?.length && d.offer?.offers?.length) {
    offer.offers = d.offer.offers;
    filled.add('offer.offers');
  }
  if (!offer.proof?.length && d.offer?.proof?.length) {
    offer.proof = d.offer.proof;
    filled.add('offer.proof');
  }
  return { next: { ...cur, company: company as Profile['company'], offer }, filled };
}

export function AiNote({ freeLeft }: { freeLeft: number }): React.ReactElement {
  return (
    <span className="text-xs text-muted-foreground">
      Uses your connected Anthropic account, or one of {freeLeft} free AI uses left for setup.
    </span>
  );
}

export function WebsiteReader({
  website,
  freeLeft,
  onDraft,
  onWebsiteChange,
}: {
  website: string;
  freeLeft: number;
  /** Typing the address saves it as the company website too. */
  onWebsiteChange: (url: string) => void;
  onDraft: (d: { company?: Profile['company']; offer?: Profile['offer'] }, url: string) => number;
}): React.ReactElement {
  const read = useReadWebsite();
  const [url, setUrl] = React.useState(website);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Not a <form>: on the profile page this sits inside the card's form.
  async function onRead() {
    if (read.isPending || url.trim().length < 4) return;
    setError(null);
    setNote(null);
    try {
      const r = await read.mutateAsync(url.trim());
      const n = onDraft(r.draft, /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
      const host = (() => { try { return new URL(r.sources[0]).host; } catch { return url; } })();
      setNote(n
        ? `Filled ${n} field${n === 1 ? '' : 's'} from ${host}, marked "from website" below. Change anything that's wrong.`
        : `Read ${host}, but every field it found is already filled in.`);
    } catch (err) {
      setError(errorMessage(err, 'Could not read that website. Fill the fields in by hand.'));
    }
  }

  return (
    <div className="glass mb-8 rounded-2xl p-5">
      <Field label="Website" htmlFor="ob-website">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input id="ob-website" className="input" type="text" inputMode="url" placeholder="acme-exports.com" value={url}
            onChange={(e) => { setUrl(e.target.value); onWebsiteChange(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void onRead(); } }} />
          <button type="button" onClick={onRead} className="btn-secondary shrink-0" disabled={read.isPending || url.trim().length < 4}>
            {read.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Globe className="h-4 w-4" aria-hidden="true" />}
            {read.isPending ? 'Reading…' : 'Read my website'}
          </button>
        </div>
      </Field>
      <div className="mt-2" aria-live="polite">
        {note ? <p className="text-xs text-primary">{note}</p> : error ? <p className="text-xs text-destructive">{error}</p> : <AiNote freeLeft={freeLeft} />}
      </div>
    </div>
  );
}

export function SampleMessage({ profile, freeLeft }: { profile: Profile; freeLeft: number }): React.ReactElement {
  const sample = useSampleMessage();
  const [p, setP] = React.useState({
    name: '',
    title: profile.customers.roles?.[0] ?? '',
    company: '',
    country: profile.customers.countries?.[0],
    context: '',
  });
  const [channel, setChannel] = React.useState<'whatsapp' | 'email'>('whatsapp');
  const [error, setError] = React.useState<string | null>(null);

  async function onWrite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await sample.mutateAsync({
        channel,
        prospect: {
          name: p.name.trim(),
          company: p.company.trim(),
          ...(p.title.trim() ? { title: p.title.trim() } : {}),
          ...(p.country ? { country: countryName(p.country) } : {}),
          ...(p.context.trim() ? { context: p.context.trim() } : {}),
        },
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not write a sample right now.'));
    }
  }

  return (
    <article className="glass rounded-2xl p-5">
      <h2 className="text-base font-semibold">Try a first message</h2>
      <p className="mt-1 mb-4 text-xs text-muted-foreground">Describe a real prospect. Nothing is sent.</p>
      <form onSubmit={onWrite} className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <input className="input" aria-label="Prospect's first name" placeholder="First name, e.g. Carla" value={p.name} maxLength={120} onChange={(e) => setP({ ...p, name: e.target.value })} required />
        <input className="input" aria-label="Their company" placeholder="Company, e.g. Frutas del Sur" value={p.company} maxLength={200} onChange={(e) => setP({ ...p, company: e.target.value })} required />
        <input className="input" aria-label="Their role" placeholder="Role" value={p.title} maxLength={120} onChange={(e) => setP({ ...p, title: e.target.value })} />
        <CountrySelect value={p.country} onChange={(c) => setP({ ...p, country: c })} />
        <input className="input md:col-span-2" aria-label="Something real about them" placeholder="Something real about them, e.g. started exporting blueberries to the Netherlands" value={p.context} maxLength={500} onChange={(e) => setP({ ...p, context: e.target.value })} />
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <select className="input w-auto" aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value as 'whatsapp' | 'email')}>
            <option value="whatsapp">WhatsApp</option>
            <option value="email">Email</option>
          </select>
          <button type="submit" className="btn-secondary" disabled={sample.isPending || !p.name.trim() || !p.company.trim()}>
            {sample.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Wand2 className="h-4 w-4" aria-hidden="true" />}
            Write a sample
          </button>
          <AiNote freeLeft={freeLeft} />
        </div>
      </form>
      <div aria-live="polite">
        {sample.data && (
          <blockquote className="mt-4 whitespace-pre-wrap rounded-xl border border-border/70 bg-card/60 p-4 text-sm leading-relaxed">
            {sample.data.message}
          </blockquote>
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    </article>
  );
}
