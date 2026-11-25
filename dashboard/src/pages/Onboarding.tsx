/**
 * Onboarding wizard (SaaS phase 3, slice 3.3): five steps that build the
 * business profile, then "how the AI understands you" with a sample
 * message, then finish. Every "Continue" saves that step's section(s), so
 * leaving half-way loses nothing. AI help (read website, understanding,
 * sample) uses the org's own Anthropic key when connected, else the
 * platform's capped onboarding allowance.
 */

import { ArrowLeft, ArrowRight, Check, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { mergeWebsiteDraft, SampleMessage, WebsiteReader } from '../components/profile/ai';
import {
  CompanyForm,
  CustomersForm,
  OfferForm,
  prepareSection,
  RulesForm,
  VoiceForm,
} from '../components/profile/sections';
import { useCompleteOnboarding, useProfile, useSaveSection, useUnderstanding } from '../hooks/useProfile';
import { errorMessage, useAuth } from '../lib/authContext';
import { cn } from '../lib/cn';
import {
  countryName,
  EMPTY_PROFILE,
  languageName,
  type Profile,
  type ProfileResponse,
  type Section,
  type Understanding,
} from '../lib/profile';

const STEPS: Array<{ label: string; title: string; intro: string; sections: Section[] }> = [
  { label: 'Your business', title: 'Your business', intro: 'Start with your website. The AI reads it and fills in what it can; you check and correct.', sections: ['company'] },
  { label: 'What you sell', title: 'What you sell', intro: 'The AI only ever says what you tell it here. Nothing is invented.', sections: ['offer'] },
  { label: 'Ideal customers', title: 'Your ideal customers', intro: 'Who should the agent look for, and who must it never contact?', sections: ['customers', 'rules'] },
  { label: 'How you sound', title: 'How you sound', intro: 'Messages go out in your name. Set the voice once; it applies in every language.', sections: ['voice'] },
  { label: 'Review', title: "Here's how the AI understands you", intro: 'Check it before anything is sent. You can change everything later in Business profile.', sections: [] },
];

export default function Onboarding(): React.ReactElement {
  const { data, isLoading, error } = useProfile();
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6 text-sm text-destructive">
        {errorMessage(error, 'Could not load your business profile.')}
      </div>
    );
  }
  return <Wizard initial={data} />;
}

function Wizard({ initial }: { initial: ProfileResponse }): React.ReactElement {
  const navigate = useNavigate();
  const { org, refresh } = useAuth();
  const { data: live } = useProfile();
  const save = useSaveSection();
  const complete = useCompleteOnboarding();

  const [step, setStep] = React.useState(0);
  const [draft, setDraft] = React.useState<Profile>({ ...EMPTY_PROFILE, ...initial.profile });
  const [fromWebsite, setFromWebsite] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [understanding, setUnderstanding] = React.useState<Understanding | null>(null);

  const onboarding = (live ?? initial).onboarding;
  const freeLeft = Math.max(0, onboarding.ai_calls_cap - onboarding.ai_calls_used);
  const current = STEPS[step];

  const setSection = <K extends Section>(k: K) => (v: Profile[K]) => setDraft((d) => ({ ...d, [k]: v }));

  /** Save every section this step edits. Returns false (and shows why) on failure. */
  async function saveStep(i: number): Promise<boolean> {
    setError(null);
    setSaving(true);
    try {
      for (const s of STEPS[i].sections) {
        await save.mutateAsync({ section: s, value: prepareSection(s, draft[s]) });
      }
      return true;
    } catch (e) {
      setError(errorMessage(e, 'Could not save. Check the fields and try again.'));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function go(to: number) {
    if (to > step && !(await saveStep(step))) return;
    setStep(to);
    window.scrollTo({ top: 0 });
  }

  async function finishLater() {
    if (await saveStep(step)) navigate('/', { replace: true });
  }

  async function finish() {
    setError(null);
    try {
      await complete.mutateAsync(understanding?.offering);
      await refresh();
      toast.success('Setup done', { description: 'Next: a few quick steps to get ready to send.' });
      navigate('/get-ready', { replace: true });
    } catch (e) {
      setError(errorMessage(e, 'Could not finish setup. Try again.'));
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-3 md:px-8">
          <div className="flex items-center gap-2.5 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            Set up {org?.name ?? draft.company.name ?? 'your business'}
          </div>
          <nav aria-label="Setup steps" className="order-3 flex w-full gap-1 overflow-x-auto pb-1 xl:order-none xl:w-auto xl:flex-1 xl:justify-center xl:pb-0">
            {STEPS.map((s, i) => (
              <button
                key={s.label}
                type="button"
                aria-current={i === step ? 'step' : undefined}
                onClick={() => go(i)}
                disabled={saving}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-full border-2 px-4 py-2 text-sm font-bold transition-colors',
                  i === step
                    ? 'border-primary bg-primary text-primary-foreground shadow-md shadow-primary/30'
                    : i < step
                      ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
                      : 'border-border text-foreground/80 hover:border-primary/50 hover:text-foreground',
                )}
              >
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold',
                  i === step ? 'bg-primary-foreground text-primary'
                    : i < step ? 'bg-primary text-primary-foreground' : 'border-2 border-current')}>
                  {i < step ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                </span>
                {s.label}
              </button>
            ))}
          </nav>
          <button type="button" className="btn-secondary ml-auto px-4 py-2 text-sm font-semibold xl:ml-0" onClick={finishLater} disabled={saving}>
            Save and finish later
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        <h1 className="text-2xl font-semibold">{current.title}</h1>
        <p className="mt-1.5 mb-8 text-sm text-muted-foreground">{current.intro}</p>

        {step === 0 && (
          <>
            <WebsiteReader
              website={draft.company.website ?? ''}
              freeLeft={freeLeft}
              onWebsiteChange={(url) => setDraft((d) => ({ ...d, company: { ...d.company, website: url } }))}
              onDraft={(d, url) => {
                const { next, filled } = mergeWebsiteDraft(draft, d, url);
                setDraft(next);
                setFromWebsite(filled);
                return filled.size;
              }}
            />
            <CompanyForm value={draft.company} onChange={setSection('company')} fromWebsite={fromWebsite} />
          </>
        )}
        {step === 1 && <OfferForm value={draft.offer} onChange={setSection('offer')} fromWebsite={fromWebsite} />}
        {step === 2 && (
          <div className="space-y-6">
            <CustomersForm value={draft.customers} onChange={setSection('customers')} />
            <RulesForm value={draft.rules} onChange={setSection('rules')} />
          </div>
        )}
        {step === 3 && <VoiceForm value={draft.voice} onChange={setSection('voice')} />}
        {step === 4 && (
          <Review profile={draft} understanding={understanding} onUnderstanding={setUnderstanding} freeLeft={freeLeft} />
        )}

        {error && (
          <div role="alert" className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="mt-10 flex items-center justify-between border-t border-border/60 pt-6">
          <button type="button" className="btn-ghost" onClick={() => go(step - 1)} disabled={step === 0 || saving}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
          </button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn-primary" onClick={() => go(step + 1)} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Continue <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className="btn-primary" onClick={finish} disabled={complete.isPending}>
              {complete.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {understanding ? 'Looks right — finish setup' : 'Finish setup'}
            </button>
          )}
        </div>
      </main>
    </div>
  );
}

function Review({
  profile,
  understanding,
  onUnderstanding,
  freeLeft,
}: {
  profile: Profile;
  understanding: Understanding | null;
  onUnderstanding: (u: Understanding) => void;
  freeLeft: number;
}): React.ReactElement {
  const { mutateAsync } = useUnderstanding();
  const [error, setError] = React.useState<string | null>(null);
  // Local flag, not the mutation's isPending: the first call starts in an
  // effect, and React's dev double-mount detaches the mutation observer,
  // which would leave isPending stuck at true.
  const [busy, setBusy] = React.useState(false);
  const started = React.useRef(false);

  const run = React.useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      onUnderstanding(await mutateAsync());
    } catch (e) {
      setError(errorMessage(e, 'The AI could not summarise your business right now.'));
    } finally {
      setBusy(false);
    }
  }, [mutateAsync, onUnderstanding]);

  React.useEffect(() => {
    if (!understanding && !started.current) {
      started.current = true;
      void run();
    }
  }, [understanding, run]);

  const o = understanding?.offering;
  const never = new Set((profile.customers.never_contact ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)).size;
  const blocked = profile.rules.blocked_countries ?? [];

  return (
    <div className="space-y-5">
      <article className="glass rounded-2xl p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">In one paragraph</h2>
          {o && (
            <button type="button" className="btn-ghost px-2 text-xs" onClick={run} disabled={busy}>
              <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden="true" /> Redo
            </button>
          )}
        </div>
        {busy && !o ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading your profile…
          </p>
        ) : o ? (
          <p className="text-sm leading-relaxed">{o.description || o.value_proposition}</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">{error}</p>
            <p className="text-muted-foreground">You can still finish setup and come back to this from Business profile.</p>
            <button type="button" className="btn-secondary" onClick={run} disabled={busy}>Try again</button>
          </div>
        )}
      </article>

      <article className="glass rounded-2xl p-5">
        <h2 className="mb-3 text-base font-semibold">Who it will look for</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Roles</dt>
          <dd>{(o?.icp.titles.length ? o.icp.titles : profile.customers.roles ?? []).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">Industries</dt>
          <dd>{(o?.icp.industries.length ? o.icp.industries : profile.customers.industries ?? []).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">Where</dt>
          <dd>{(profile.customers.countries ?? []).map(countryName).join(', ') || '—'}</dd>
          <dt className="text-muted-foreground">Writes in</dt>
          <dd>{(profile.company.languages_handled ?? []).map(languageName).join(', ') || 'Each prospect\'s own language'}</dd>
          <dt className="text-muted-foreground">Skips</dt>
          <dd>
            {never} on your never-contact list
            {blocked.length ? ` · ${blocked.map(countryName).join(', ')}` : ''}
          </dd>
        </dl>
        {o?.routing.angles.length ? (
          <>
            <h3 className="mt-5 mb-2 text-sm font-semibold">What it will lead with</h3>
            <ul className="space-y-2 text-sm">
              {o.routing.angles.map((a) => (
                <li key={a.label}>
                  <span className="font-medium">{a.label}</span>
                  <span className="text-muted-foreground"> — for {a.fits}: {a.lead_with}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm"><span className="text-muted-foreground">Asks for:</span> {o.routing.cta}</p>
          </>
        ) : null}
      </article>

      <SampleMessage profile={profile} freeLeft={freeLeft} />
    </div>
  );
}
