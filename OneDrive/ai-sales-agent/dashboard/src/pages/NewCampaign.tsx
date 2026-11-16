/**
 * New campaign (SaaS phase 2, slice 2.5): 1 Leads → 2 Channels & language
 * → 3 Details → 4 Review.
 *
 * Leads come from the AI agent (describe who you sell to → an offering
 * draft with the ideal-customer profile, or a saved offering) or from an
 * uploaded Excel/CSV list. "Create" saves a new offering if needed, then
 * the campaign as a DRAFT. AI campaigns can launch straight away (the API
 * refuses while a channel has no connected account); upload campaigns go
 * to the import page first and launch after the list is in — launching
 * one with no contacts would start AI discovery instead.
 */

import { ArrowLeft, ArrowRight, Bot, Check, FileSpreadsheet, Loader2, Rocket, Sparkles, Upload } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Field, TagInput, ToggleChips } from '../components/profile/fields';
import { PageHeader } from '../components/ui/page-header';
import { useProfile } from '../hooks/useProfile';
import { useCredentials, useOfferings, useOrganization } from '../hooks/useWorkspace';
import { api, ApiClientError } from '../lib/api';
import { errorMessage } from '../lib/authContext';
import { cn } from '../lib/cn';
import { setPendingImport } from '../lib/pendingImport';
import { COMPANY_SIZES, LANGUAGES, languageName, type Offering } from '../lib/profile';
import { CHANNEL_LABEL, CHANNEL_PROVIDERS, connectedFor, type OrgChannel, verifiedFor } from '../lib/workspace';

type Source = 'ai' | 'upload';

interface GeneratedDraft {
  offering: Offering;
  suggested_channels: OrgChannel[];
  suggested_languages: string[];
  campaign_goal: string;
  source_prompt: string;
}

const STEPS = ['Leads', 'Channels & language', 'Details', 'Review'] as const;
/** Channels a campaign can use today (voice: the call engine is phase 4). */
const USABLE: OrgChannel[] = ['email', 'whatsapp', 'linkedin'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export default function NewCampaign(): React.ReactElement {
  const navigate = useNavigate();
  const org = useOrganization();
  const creds = useCredentials();
  const offerings = useOfferings();
  const profile = useProfile();

  const [step, setStep] = React.useState(0);
  const [source, setSource] = React.useState<Source>('ai');
  // AI source
  const [prompt, setPrompt] = React.useState('');
  const [generated, setGenerated] = React.useState<GeneratedDraft | null>(null);
  const [savedId, setSavedId] = React.useState<string>('');
  const [generating, setGenerating] = React.useState(false);
  // Upload source
  const [file, setFile] = React.useState<File | null>(null);
  // Channels & language
  const [channels, setChannels] = React.useState<OrgChannel[]>([]);
  const [langMode, setLangMode] = React.useState<'own' | 'fixed'>('own');
  const [fixedLang, setFixedLang] = React.useState('en');
  const [fallback, setFallback] = React.useState<'country' | 'org_default'>('country');
  // Details
  const [details, setDetails] = React.useState({ name: '', goal: 'Book a short call', sender_name: '', sender_company: '' });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const allowed = (org.data?.channels ?? []).filter((c) => USABLE.includes(c));
  const saved = offerings.data ?? [];
  const savedOffering = saved.find((o) => o.id === savedId);
  // Upload campaigns pitch a saved offering, else the profile's value proposition.
  const profileVp = profile.data?.profile.offer.value_proposition?.trim() ?? '';

  // Defaults once data arrives.
  React.useEffect(() => {
    if (!savedId && saved.length) setSavedId(saved[0].id);
  }, [saved, savedId]);
  React.useEffect(() => {
    if (!channels.length && allowed.length) setChannels(allowed.filter((c) => c !== 'linkedin'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed.join()]);
  React.useEffect(() => {
    const p = profile.data?.profile;
    if (!p) return;
    setDetails((d) => ({
      ...d,
      sender_name: d.sender_name || p.voice.sender_name || '',
      sender_company: d.sender_company || p.company.name || '',
    }));
  }, [profile.data]);

  const offeringForCampaign: Offering | undefined =
    source === 'ai' ? (generated?.offering ?? savedOffering) : savedOffering;

  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      const { data } = await api.post<GeneratedDraft>('/api/offerings/generate', { description: prompt.trim() });
      setGenerated(data);
      const sugg = data.suggested_channels.filter((c) => allowed.includes(c));
      if (sugg.length) setChannels(sugg);
      if (data.campaign_goal) setDetails((d) => ({ ...d, goal: data.campaign_goal }));
      if (!details.name) setDetails((d) => ({ ...d, name: data.offering.name }));
    } catch (e) {
      setError(errorMessage(e, 'The AI could not draft a profile right now.'));
    } finally {
      setGenerating(false);
    }
  }

  function stepProblem(i: number): string | null {
    if (i === 0) {
      if (source === 'ai' && !generated && !savedOffering) return 'Describe who you sell to and draft the profile, or pick a saved offering.';
      if (source === 'upload') {
        if (!file) return 'Choose the Excel or CSV file to upload.';
        if (!savedOffering && !profileVp) return 'Say what you sell first: add a value proposition to your business profile.';
      }
    }
    if (i === 1 && channels.length === 0) return 'Choose at least one channel.';
    if (i === 2) {
      if (!details.name.trim()) return 'Give the campaign a name.';
      if (!details.goal.trim()) return 'Say what the campaign should achieve.';
      if (!details.sender_name.trim() || !details.sender_company.trim()) return 'Add the sender name and company.';
    }
    return null;
  }

  function next() {
    const p = stepProblem(step);
    if (p) {
      setError(p);
      return;
    }
    setError(null);
    if (step === 0 && !details.name && offeringForCampaign) setDetails((d) => ({ ...d, name: offeringForCampaign.name }));
    setStep(step + 1);
    window.scrollTo({ top: 0 });
  }

  async function create(launch: boolean) {
    setError(null);
    setBusy(true);
    let campaignId: string | null = null;
    try {
      let offeringId: string | undefined = source === 'ai' && generated ? undefined : savedOffering?.id;
      if (source === 'ai' && generated) {
        const { data } = await api.post<{ id: string }>('/api/offerings', {
          ...generated.offering,
          source_prompt: generated.source_prompt,
        });
        offeringId = data.id;
        setGenerated(null); // saved now: don't save it twice on a retry
        setSavedId(data.id);
        offerings.refetch();
      }
      const { data: campaign } = await api.post<{ id: string }>('/api/campaigns', {
        name: details.name.trim(),
        goal: details.goal.trim(),
        sender_name: details.sender_name.trim(),
        sender_company: details.sender_company.trim(),
        ...(offeringId ? { offering_id: offeringId } : { value_proposition: profileVp }),
        channels,
        languages: langMode === 'fixed' ? [fixedLang] : null,
        language_fallback: fallback,
      });
      campaignId = campaign.id;

      if (source === 'upload') {
        setPendingImport(campaign.id, file!);
        navigate(`/campaigns/${campaign.id}/import`);
        return;
      }
      if (launch) {
        await api.patch(`/api/campaigns/${campaign.id}/status`, { status: 'ACTIVE' });
        toast.success('Campaign launched', { description: 'The agent starts finding and writing to prospects within minutes.' });
      } else {
        toast.success('Campaign saved as a draft');
      }
      navigate('/campaigns');
    } catch (e) {
      if (campaignId && e instanceof ApiClientError && e.status === 409) {
        // Created, but a channel still has no account: keep the draft.
        toast.error('Saved as a draft — not launched', { description: errorMessage(e) });
        navigate('/settings/connections');
        return;
      }
      setError(errorMessage(e, 'Could not create the campaign.'));
    } finally {
      setBusy(false);
    }
  }

  // Campaigns send only through verified accounts (slice 3.4).
  const missing = channels.filter((c) => !verifiedFor(creds.data, CHANNEL_PROVIDERS[c]));
  const needsAiKey = !org.data?.operator && !verifiedFor(creds.data, ['anthropic']);
  const needsApollo = source === 'ai' && !org.data?.operator && !verifiedFor(creds.data, ['apollo']);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Campaigns"
        title="New campaign"
        description="Choose where the leads come from, how to reach them, and launch. Nothing is sent until you launch."
        icon={Rocket}
        actions={org.data?.operator ? <Link to="/campaigns/new/manual" className="btn-ghost text-xs">Set up targeting by hand</Link> : undefined}
      />

      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => i < step && setStep(i)}
              disabled={i > step}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium',
                i === step ? 'bg-primary/15 text-primary' : i < step ? 'text-foreground hover:bg-accent/50' : 'text-muted-foreground',
              )}
            >
              <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px]', i < step ? 'bg-primary text-primary-foreground' : 'border border-current')}>
                {i < step ? <Check className="h-3 w-3" aria-hidden="true" /> : i + 1}
              </span>
              {s}
            </button>
          </li>
        ))}
      </ol>

      <div className="max-w-3xl">
        {step === 0 && (
          <div className="space-y-6">
            <h2 className="text-xl font-semibold">Where should your leads come from?</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Lead source">
              <SourceCard on={source === 'ai'} onClick={() => setSource('ai')} icon={Bot} title="Ask the AI agent"
                text="Describe who you sell to. The agent finds matching companies and decision-makers." />
              <SourceCard on={source === 'upload'} onClick={() => setSource('upload')} icon={FileSpreadsheet} title="Upload a list"
                text="Bring an Excel or CSV of people you already want to reach. We map the columns for you." />
            </div>

            {source === 'ai' ? (
              <div className="space-y-5">
                {saved.length > 0 && !generated && (
                  <Field label="Use a saved offering" htmlFor="nc-saved" hint="Built from your business profile, or from an earlier campaign.">
                    <select id="nc-saved" className="input" value={savedId} onChange={(e) => setSavedId(e.target.value)}>
                      {saved.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </Field>
                )}
                <div className="glass rounded-2xl p-5 space-y-3">
                  <Field label={saved.length ? 'Or describe a new audience' : 'Describe your business and who you want to reach'} htmlFor="nc-prompt" hint="Write in any language. The agent understands it.">
                    <textarea id="nc-prompt" className="input min-h-[110px]" maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                      placeholder="We make export-grade food packaging. Find procurement heads at mid-size food exporters in the UAE, Saudi Arabia and Peru, 50–500 employees." />
                  </Field>
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" className="btn-secondary" onClick={generate} disabled={generating || prompt.trim().length < 20}>
                      {generating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
                      {generating ? 'Drafting…' : 'Draft my ideal customer profile'}
                    </button>
                    {needsAiKey && (
                      <span className="text-xs text-muted-foreground">Needs your verified AI model account — <Link className="underline" to="/settings/connections">connect it</Link>.</span>
                    )}
                  </div>
                </div>
                {generated ? (
                  <IcpEditor draft={generated} onChange={setGenerated} onDiscard={() => setGenerated(null)} />
                ) : savedOffering ? (
                  <IcpSummary offering={savedOffering} />
                ) : null}
              </div>
            ) : (
              <div className="space-y-5">
                <FilePicker file={file} onFile={setFile} />
                <Field label="What are you offering them?" htmlFor="nc-upload-offering"
                  hint={saved.length ? 'Messages are written from this offering.' : 'Messages are written from your business profile.'}>
                  {saved.length ? (
                    <select id="nc-upload-offering" className="input" value={savedId} onChange={(e) => setSavedId(e.target.value)}>
                      {saved.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  ) : (
                    <p className="text-sm">{profileVp || <Link className="underline" to="/settings/profile">Add what you sell to your business profile</Link>}</p>
                  )}
                </Field>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-8">
            <h2 className="text-xl font-semibold">How should we reach them?</h2>
            <section className="space-y-3">
              <h3 className="label">Channels</h3>
              <div className="flex flex-wrap gap-2">
                {[
                  ['Email + WhatsApp', ['email', 'whatsapp']],
                  ['Email only', ['email']],
                  ['WhatsApp only', ['whatsapp']],
                ].filter(([, cs]) => (cs as OrgChannel[]).every((c) => allowed.includes(c))).map(([label, cs]) => (
                  <button key={label as string} type="button" className="chip-removable" onClick={() => setChannels(cs as OrgChannel[])}>{label as string}</button>
                ))}
              </div>
              <div className="space-y-2">
                {(org.data?.channels ?? []).map((c) => {
                  const usable = USABLE.includes(c);
                  const on = channels.includes(c);
                  const cred = connectedFor(creds.data, CHANNEL_PROVIDERS[c]);
                  const verified = verifiedFor(creds.data, CHANNEL_PROVIDERS[c]);
                  return (
                    <label key={c} className={cn('glass flex items-center gap-3 rounded-xl p-3.5', !usable && 'opacity-60')}>
                      <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" disabled={!usable} checked={on}
                        onChange={() => setChannels(on ? channels.filter((x) => x !== c) : [...channels, c])} />
                      <span className="flex-1 text-sm font-medium">{CHANNEL_LABEL[c]}</span>
                      <span className="text-xs text-muted-foreground">
                        {!usable ? 'Coming soon' : org.data?.operator ? 'Uses server keys' : verified ? 'Account verified' : cred ? 'Connected, not verified' : 'Not connected yet'}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Contacts without a phone number skip WhatsApp; contacts without an email skip email.
              </p>
            </section>
            <section className="space-y-3">
              <h3 className="label">Language</h3>
              <div className="space-y-2">
                <label className="glass flex items-start gap-3 rounded-xl p-3.5">
                  <input type="radio" name="lang" className="mt-1 accent-[hsl(var(--primary))]" checked={langMode === 'own'} onChange={() => setLangMode('own')} />
                  <span><span className="text-sm font-medium">Each contact's own language</span><br />
                    <span className="text-xs text-muted-foreground">Recommended. Written natively per contact, limited to the languages your team answers in.</span></span>
                </label>
                <label className="glass flex items-start gap-3 rounded-xl p-3.5">
                  <input type="radio" name="lang" className="mt-1 accent-[hsl(var(--primary))]" checked={langMode === 'fixed'} onChange={() => setLangMode('fixed')} />
                  <span><span className="text-sm font-medium">One language for everyone</span><br />
                    <span className="text-xs text-muted-foreground">Use when your list shares a language.</span></span>
                </label>
              </div>
              {langMode === 'fixed' ? (
                <Field label="Language" htmlFor="nc-lang">
                  <select id="nc-lang" className="input" value={fixedLang} onChange={(e) => setFixedLang(e.target.value)}>
                    {LANGUAGES.map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
                  </select>
                </Field>
              ) : (
                <Field label="If a contact's language is unknown" htmlFor="nc-fallback">
                  <select id="nc-fallback" className="input" value={fallback} onChange={(e) => setFallback(e.target.value as 'country' | 'org_default')}>
                    <option value="country">Guess from their country</option>
                    <option value="org_default">Use {languageName(org.data?.default_language ?? 'en')} (your default)</option>
                  </select>
                </Field>
              )}
              <p className="text-xs text-muted-foreground">Opt-out replies are understood in every language, and the confirmation goes back in the contact's language.</p>
            </section>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-xl font-semibold">Campaign details</h2>
            <Field label="Campaign name" htmlFor="nc-name">
              <input id="nc-name" className="input" maxLength={255} value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
            </Field>
            <Field label="Goal" htmlFor="nc-goal" hint="What a reply should lead to, e.g. a 15-minute call.">
              <input id="nc-goal" className="input" value={details.goal} onChange={(e) => setDetails({ ...details, goal: e.target.value })} />
            </Field>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Field label="Sender name" htmlFor="nc-sn">
                <input id="nc-sn" className="input" maxLength={255} value={details.sender_name} onChange={(e) => setDetails({ ...details, sender_name: e.target.value })} />
              </Field>
              <Field label="Sender company" htmlFor="nc-sc">
                <input id="nc-sc" className="input" maxLength={255} value={details.sender_company} onChange={(e) => setDetails({ ...details, sender_company: e.target.value })} />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Tone, formality, proof and words to avoid come from your <Link className="underline" to="/settings/profile">business profile</Link>.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-xl font-semibold">Review</h2>
            <section className="glass rounded-2xl p-5">
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">Campaign</dt><dd>{details.name}</dd>
                <dt className="text-muted-foreground">Leads</dt>
                <dd>{source === 'ai' ? `AI agent finds them${offeringForCampaign ? ` — ${offeringForCampaign.name}` : ''}` : `From ${file?.name}`}</dd>
                <dt className="text-muted-foreground">Channels</dt><dd>{channels.map((c) => CHANNEL_LABEL[c]).join(', ')}</dd>
                <dt className="text-muted-foreground">Language</dt>
                <dd>{langMode === 'fixed' ? languageName(fixedLang) : `Each contact's own (unknown: ${fallback === 'country' ? 'from their country' : languageName(org.data?.default_language ?? 'en')})`}</dd>
                <dt className="text-muted-foreground">Sender</dt><dd>{details.sender_name}, {details.sender_company}</dd>
                <dt className="text-muted-foreground">Goal</dt><dd>{details.goal}</dd>
              </dl>
            </section>
            {(missing.length > 0 || needsAiKey || needsApollo) && !org.data?.operator && (
              <section className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
                <p className="font-medium">Before it can run</p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {missing.map((c) => <li key={c}>Connect and verify a {CHANNEL_LABEL[c]} account</li>)}
                  {needsAiKey && <li>Connect and verify your AI model account (it writes the messages)</li>}
                  {needsApollo && <li>Connect and verify lead search (Apollo) so the agent can find people</li>}
                </ul>
                <Link to="/settings/connections" className="mt-2 inline-block text-sm font-medium underline">Open connected accounts</Link>
                <p className="mt-2 text-xs text-muted-foreground">You can save the campaign as a draft now.</p>
              </section>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
        )}

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-6">
          <button type="button" className="btn-ghost" onClick={() => { setError(null); setStep(step - 1); }} disabled={step === 0 || busy}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn-primary" onClick={next}>
              Continue <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : source === 'upload' ? (
            <button type="button" className="btn-primary" onClick={() => create(false)} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
              Create and upload the list
            </button>
          ) : (
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={() => create(false)} disabled={busy}>Save as draft</button>
              <button type="button" className="btn-primary" onClick={() => create(true)} disabled={busy || ((missing.length > 0 || needsAiKey || needsApollo) && !org.data?.operator)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
                Create and launch
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SourceCard({ on, onClick, icon: Icon, title, text }: {
  on: boolean; onClick: () => void; icon: typeof Bot; title: string; text: string;
}): React.ReactElement {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
      className={cn('glass rounded-2xl p-5 text-left transition-colors', on ? 'ring-2 ring-primary' : 'hover:bg-card/90')}>
      <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
      <div className="mt-3 font-semibold">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{text}</p>
    </button>
  );
}

function IcpSummary({ offering }: { offering: Offering }): React.ReactElement {
  const icp = offering.icp;
  return (
    <section className="glass rounded-2xl p-5">
      <h3 className="mb-3 text-base font-semibold">Who the agent will look for</h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted-foreground">Job titles</dt><dd>{icp.titles.join(', ') || '—'}</dd>
        <dt className="text-muted-foreground">Industries</dt><dd>{icp.industries.join(', ') || '—'}</dd>
        <dt className="text-muted-foreground">Company size</dt><dd>{icp.company_sizes.map((s) => s.replace('-', '–')).join(', ') || 'Any'}</dd>
        <dt className="text-muted-foreground">Countries</dt><dd>{icp.countries.join(', ') || 'Anywhere'}</dd>
      </dl>
    </section>
  );
}

function IcpEditor({ draft, onChange, onDiscard }: {
  draft: GeneratedDraft; onChange: (d: GeneratedDraft) => void; onDiscard: () => void;
}): React.ReactElement {
  const icp = draft.offering.icp;
  const setIcp = (patch: Partial<typeof icp>) => onChange({ ...draft, offering: { ...draft.offering, icp: { ...icp, ...patch } } });
  return (
    <section className="glass rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">AI draft: ideal customer profile</h3>
        <button type="button" className="btn-ghost px-2 text-xs" onClick={onDiscard}>Discard</button>
      </div>
      <p className="text-sm">{draft.offering.value_proposition}</p>
      <Field label="Job titles"><TagInput values={icp.titles} onChange={(v) => setIcp({ titles: v })} max={15} /></Field>
      <Field label="Industries"><TagInput values={icp.industries} onChange={(v) => setIcp({ industries: v })} max={15} /></Field>
      <Field label="Company size"><ToggleChips options={COMPANY_SIZES} values={icp.company_sizes} onChange={(v) => setIcp({ company_sizes: v })} /></Field>
      <Field label="Countries"><TagInput values={icp.countries} onChange={(v) => setIcp({ countries: v })} max={30} /></Field>
      <p className="text-xs text-muted-foreground">Saved as an offering when you create the campaign. Nothing is sent until you launch.</p>
    </section>
  );
}

function FilePicker({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }): React.ReactElement {
  const [drag, setDrag] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const accept = (f: File | undefined) => {
    setProblem(null);
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) return setProblem('Choose an .xlsx or .csv file.');
    if (f.size > MAX_FILE_BYTES) return setProblem('That file is larger than 10 MB.');
    onFile(f);
  };
  return (
    <div>
      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); accept(e.dataTransfer.files[0]); }}
        className={cn('flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition-colors',
          drag ? 'border-primary bg-primary/10' : 'border-border/80 hover:border-primary/60')}
      >
        <FileSpreadsheet className="h-8 w-8 text-primary" aria-hidden="true" />
        {file ? (
          <span className="text-sm font-medium">{file.name} · {Math.max(1, Math.round(file.size / 1024))} KB</span>
        ) : (
          <span className="text-sm"><span className="font-medium">Drop an .xlsx or .csv file here</span> or browse your files</span>
        )}
        <span className="text-xs text-muted-foreground">Column headers can be in any language. We suggest the mapping; you confirm it.</span>
        <input type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => accept(e.target.files?.[0])} />
      </label>
      {problem && <p className="mt-2 text-sm text-destructive">{problem}</p>}
      <p className="mt-2 text-xs text-muted-foreground">Useful columns: name, company, title, email, phone, country, language. Up to 10,000 rows.</p>
    </div>
  );
}
