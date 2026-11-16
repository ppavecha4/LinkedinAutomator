/**
 * Settings › Business profile (SaaS phase 3, slice 3.3). Everything the AI
 * knows about the business: one card per section with a summary, edited
 * in place (same forms as onboarding). Side column: profile strength with
 * the next things to add, how the engine uses each part, and a sample
 * message test. Viewers can look but not edit (the API enforces it).
 */

import { Building2, Loader2, Megaphone, Pencil, ShieldBan, Target, UserRound } from 'lucide-react';
import * as React from 'react';
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
import { PageHeader } from '../components/ui/page-header';
import { Progress } from '../components/ui/progress';
import { useProfile, useSaveSection } from '../hooks/useProfile';
import { errorMessage, useAuth } from '../lib/authContext';
import {
  countryName,
  languageName,
  type Profile,
  type ProfileResponse,
  type Section,
  SIGNAL_LABELS,
  TONE_LABELS,
} from '../lib/profile';

const CARDS: Array<{ section: Section; title: string; icon: typeof Building2 }> = [
  { section: 'company', title: 'Company', icon: Building2 },
  { section: 'offer', title: 'What you sell', icon: Megaphone },
  { section: 'customers', title: 'Ideal customers', icon: Target },
  { section: 'voice', title: 'Voice and sender', icon: UserRound },
  { section: 'rules', title: 'Rules and exclusions', icon: ShieldBan },
];

const USES: Array<[string, string]> = [
  ['Finding prospects', 'Your offering, built from this profile, becomes the search: roles, industries, sizes and countries.'],
  ['Skipping people', 'The never-contact list, blocked countries and opt-outs are checked when finding, importing and again before every send.'],
  ['Choosing what to say', 'Each prospect gets the offer and problem that fit them; only proof you allowed is ever cited.'],
  ['How it sounds', 'Tone, formality, sender, meeting link and words to avoid, in every language.'],
  ['Which language', "Each prospect's own language, limited to the languages your team can answer in."],
];

export default function BusinessProfile(): React.ReactElement {
  const { data, isLoading, error } = useProfile();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Settings"
        title="Business profile"
        description="Everything the AI knows about your business. Changes apply to prospects found and messages written from now on."
        icon={Building2}
      />
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" />
        </div>
      ) : error || !data ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage(error, 'Could not load your business profile.')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-5">
            {CARDS.map((c) => (
              <SectionCard key={c.section} card={c} data={data} />
            ))}
          </div>
          <aside className="space-y-5">
            <Strength data={data} />
            <section className="glass rounded-2xl p-5">
              <h2 className="mb-3 text-base font-semibold">How the AI uses your profile</h2>
              <dl className="space-y-3 text-sm">
                {USES.map(([t, d]) => (
                  <div key={t}>
                    <dt className="font-medium">{t}</dt>
                    <dd className="text-muted-foreground">{d}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <SampleMessage profile={data.profile} freeLeft={Math.max(0, data.onboarding.ai_calls_cap - data.onboarding.ai_calls_used)} />
          </aside>
        </div>
      )}
    </div>
  );
}

function Strength({ data }: { data: ProfileResponse }): React.ReactElement {
  const { score, missing } = data.completeness;
  return (
    <section className="glass rounded-2xl p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Profile strength</h2>
        <span className="text-2xl font-semibold tabular-nums">{score}%</span>
      </div>
      <Progress value={score} className="mt-3" aria-label={`Profile ${score}% complete`} />
      {missing.length ? (
        <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
          {missing.slice(0, 3).map((m) => (
            <li key={m.item}>· {m.hint}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Complete. The AI has what it needs.</p>
      )}
    </section>
  );
}

function SectionCard({
  card,
  data,
}: {
  card: (typeof CARDS)[number];
  data: ProfileResponse;
}): React.ReactElement {
  const { user } = useAuth();
  const canEdit = user?.role !== 'viewer';
  const save = useSaveSection();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Profile[Section]>(data.profile[card.section]);
  const [fromWebsite, setFromWebsite] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const missing = data.completeness.missing.filter((m) => m.section === card.section).length;
  const Icon = card.icon;

  function startEdit() {
    setDraft(data.profile[card.section]);
    setFromWebsite(new Set());
    setError(null);
    setEditing(true);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await save.mutateAsync({ section: card.section, value: prepareSection(card.section, draft) });
      setEditing(false);
      toast.success(`${card.title} saved`);
    } catch (err) {
      setError(errorMessage(err, 'Could not save. Check the fields and try again.'));
    }
  }

  return (
    <section className="glass rounded-2xl p-5" aria-labelledby={`card-${card.section}`}>
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <h2 id={`card-${card.section}`} className="text-base font-semibold">{card.title}</h2>
        <span className={missing ? 'text-xs text-amber-600 dark:text-amber-400' : 'text-xs text-muted-foreground'}>
          {missing ? `${missing} thing${missing === 1 ? '' : 's'} missing` : 'Complete'}
        </span>
        {!editing && canEdit && (
          <button type="button" className="btn-ghost ml-auto px-2.5 py-1.5 text-xs" onClick={startEdit} aria-label={`Edit ${card.title}`}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <form onSubmit={onSave}>
          {card.section === 'company' && (
            <>
              <WebsiteReader
                website={(draft as Profile['company']).website ?? ''}
                freeLeft={Math.max(0, data.onboarding.ai_calls_cap - data.onboarding.ai_calls_used)}
                onWebsiteChange={(url) => setDraft({ ...(draft as Profile['company']), website: url })}
                onDraft={(d, url) => {
                  // Here only the company card is open: apply its part.
                  const cur = { ...data.profile, company: draft as Profile['company'] };
                  const { next, filled } = mergeWebsiteDraft(cur, { company: d.company }, url);
                  setDraft(next.company);
                  setFromWebsite(filled);
                  return filled.size;
                }}
              />
              <CompanyForm value={draft as Profile['company']} onChange={setDraft} fromWebsite={fromWebsite} />
            </>
          )}
          {card.section === 'offer' && <OfferForm value={draft as Profile['offer']} onChange={setDraft} />}
          {card.section === 'customers' && <CustomersForm value={draft as Profile['customers']} onChange={setDraft} />}
          {card.section === 'voice' && <VoiceForm value={draft as Profile['voice']} onChange={setDraft} />}
          {card.section === 'rules' && <RulesForm value={draft as Profile['rules']} onChange={setDraft} />}
          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)} disabled={save.isPending}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </button>
          </div>
        </form>
      ) : (
        <Summary section={card.section} profile={data.profile} />
      )}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, React.ReactNode]> }): React.ReactElement {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!shown.length) return <p className="text-sm text-muted-foreground">Nothing here yet.</p>;
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {shown.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

const list = (xs: string[] | undefined) => (xs?.length ? xs.join(', ') : '');

function Summary({ section, profile }: { section: Section; profile: Profile }): React.ReactElement {
  const { company: c, offer: o, customers: k, voice: v, rules: r } = profile;
  switch (section) {
    case 'company':
      return (
        <Rows rows={[
          ['Name', c.name],
          ['Website', c.website],
          ['Industry', c.industry],
          ['Headquarters · size', [c.hq_country && countryName(c.hq_country), c.size && `${c.size.replace('-', '–')} people`].filter(Boolean).join(' · ')],
          ['Team replies in', list(c.languages_handled?.map(languageName))],
          ['What you do', c.description],
        ]} />
      );
    case 'offer': {
      const allowed = (o.proof ?? []).filter((p) => p.may_mention).map((p) => p.text);
      const hidden = (o.proof ?? []).length - allowed.length;
      return (
        <Rows rows={[
          ['Offers', list(o.offers?.map((x) => x.name))],
          ['Why customers choose you', o.value_proposition],
          ['Proof the AI may cite', list(allowed)],
          ['Kept private', hidden ? `${hidden} proof point${hidden === 1 ? '' : 's'} (never sent to the AI)` : ''],
          ['Prices', o.price_policy === 'starting_price' ? 'May offer to share pricing' : 'Never mentioned'],
        ]} />
      );
    }
    case 'customers':
      return (
        <Rows rows={[
          ['Roles', list(k.roles)],
          ['Industries', list(k.industries)],
          ['Company sizes', list(k.company_sizes?.map((s) => s.replace('-', '–')))],
          ['Countries', list(k.countries?.map(countryName))],
          ['Buying signals', list(k.signals?.map((s) => SIGNAL_LABELS[s]))],
          ['Problems you solve', k.problems],
        ]} />
      );
    case 'voice':
      return (
        <Rows rows={[
          ['Tone · formality', v.tone || v.formality ? `${TONE_LABELS[v.tone ?? 'professional']} · ${v.formality ?? 'formal'}` : ''],
          ['Sender', [v.sender_name, v.sender_title].filter(Boolean).join(', ')],
          ['Meeting link', v.meeting_link],
          ['Never say', list(v.avoid)],
          ['Style example', v.example ? 'Saved (style only, facts never reused)' : ''],
        ]} />
      );
    case 'rules': {
      const never = (k.never_contact ?? []).length;
      return (
        <Rows rows={[
          ['Never contact', never ? `${never} domain${never === 1 ? '' : 's'} or compan${never === 1 ? 'y' : 'ies'} (edit under Ideal customers)` : 'None (add them under Ideal customers)'],
          ['Blocked countries', list(r.blocked_countries?.map(countryName)) || 'None'],
          ['Opted out', 'Kept automatically, in every language'],
        ]} />
      );
    }
  }
}
