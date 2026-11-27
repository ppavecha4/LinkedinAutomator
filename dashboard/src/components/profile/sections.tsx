/**
 * The five business-profile sections as controlled forms. Used by the
 * onboarding wizard (one per step) and Settings › Business profile (one
 * per card in edit mode). `prepareSection()` turns form state into the
 * exact body PUT /api/profile/:section accepts.
 */

import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';

import { t } from '../../i18n';
import {
  clean,
  COMPANY_SIZES,
  type CompanySection,
  type CustomersSection,
  type OfferSection,
  type RulesSection,
  type Section,
  SIGNAL_LABELS,
  SIGNALS,
  TONE_LABELS,
  TONES,
  type VoiceSection,
} from '../../lib/profile';
import { CountriesPicker, CountrySelect, Field, LanguagesPicker, Segmented, TagInput, ToggleChips } from './fields';

const SIZE_LABELS = Object.fromEntries(COMPANY_SIZES.map((s) => [s, s.replace('-', '–')])) as Record<
  (typeof COMPANY_SIZES)[number],
  string
>;

function withScheme(url: string | null | undefined): string | undefined {
  const u = (url ?? '').trim();
  if (!u) return undefined;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Form state → the body the API validates (trimmed, no empty values). */
export function prepareSection(section: Section, value: object): object {
  switch (section) {
    case 'company': {
      const v = value as CompanySection;
      return clean({ ...v, website: withScheme(v.website) });
    }
    case 'offer': {
      const v = value as OfferSection;
      return clean({
        ...v,
        offers: (v.offers ?? []).filter((o) => o.name.trim()).map((o) => clean(o)),
        proof: (v.proof ?? []).filter((p) => p.text.trim()).map((p) => ({ text: p.text.trim(), may_mention: p.may_mention })),
      });
    }
    case 'customers': {
      const v = value as CustomersSection;
      const seen = new Set<string>();
      const never = (v.never_contact ?? [])
        .map((s) => s.trim())
        .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
      return clean({ ...v, never_contact: never });
    }
    case 'voice': {
      const v = value as VoiceSection;
      return clean({ ...v, meeting_link: withScheme(v.meeting_link) });
    }
    default:
      return clean(value);
  }
}

export interface SectionProps<T> {
  value: T;
  onChange: (next: T) => void;
  /** Fields pre-filled from the website, shown with a badge. */
  fromWebsite?: ReadonlySet<string>;
}

// ── Company ──────────────────────────────────────────────────────────────

export function CompanyForm({ value: v, onChange, fromWebsite }: SectionProps<CompanySection>): React.ReactElement {
  const set = <K extends keyof CompanySection>(k: K, x: CompanySection[K]) => onChange({ ...v, [k]: x });
  const fw = (k: string) => fromWebsite?.has(`company.${k}`);
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <Field label={t('Company name')} fromWebsite={fw('name')} htmlFor="p-name">
        <input id="p-name" className="input" value={v.name ?? ''} onChange={(e) => set('name', e.target.value)} maxLength={255} required />
      </Field>
      <Field label={t('Legal company name')} htmlFor="p-legal" hint={t('If different from the name above. Shown in the footer of every email.')}>
        <input id="p-legal" className="input" value={v.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} maxLength={255} placeholder={t('e.g. Acme Packaging S.A.C.')} />
      </Field>
      <Field label={t('Postal address')} htmlFor="p-address" hint={t('Required to send email: the law asks every commercial email to say who sends it and where. Shown in the footer.')} className="md:col-span-2">
        <input id="p-address" className="input" value={v.address ?? ''} onChange={(e) => set('address', e.target.value)} maxLength={300} placeholder={t('Street, number, city, postal code, country')} />
      </Field>
      <Field label={t('Industry')} fromWebsite={fw('industry')} htmlFor="p-industry">
        <input id="p-industry" className="input" value={v.industry ?? ''} onChange={(e) => set('industry', e.target.value)} maxLength={150} placeholder={t('e.g. Food packaging manufacturing')} />
      </Field>
      <Field label={t('Company size')} htmlFor="p-size">
        <select id="p-size" className="input" value={v.size ?? ''} onChange={(e) => set('size', (e.target.value || undefined) as CompanySection['size'])}>
          <option value="">{t('Choose a size')}</option>
          {COMPANY_SIZES.map((s) => (
            <option key={s} value={s}>{t('{value} people', { value: SIZE_LABELS[s] })}</option>
          ))}
        </select>
      </Field>
      <Field label={t('Headquarters')} fromWebsite={fw('hq_country')} htmlFor="p-hq">
        <CountrySelect id="p-hq" value={v.hq_country} onChange={(x) => set('hq_country', x)} />
      </Field>
      <Field label={t('What you do, in one or two sentences')} fromWebsite={fw('description')} className="md:col-span-2" htmlFor="p-desc">
        <textarea id="p-desc" className="input min-h-[90px]" value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} maxLength={1500} />
      </Field>
      <Field
        label={t('Languages your team can answer replies in')}
        fromWebsite={fw('languages_handled')}
        hint={t('The AI only writes in these, so nobody gets a reply you can\'t read.')}
        className="md:col-span-2"
      >
        <LanguagesPicker values={v.languages_handled ?? []} onChange={(x) => set('languages_handled', x)} />
      </Field>
    </div>
  );
}

// ── What you sell ────────────────────────────────────────────────────────

export function OfferForm({ value: v, onChange, fromWebsite }: SectionProps<OfferSection>): React.ReactElement {
  const offers = v.offers ?? [];
  const proof = v.proof ?? [];
  const setOffer = (i: number, patch: Partial<(typeof offers)[number]>) =>
    onChange({ ...v, offers: offers.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const setProof = (i: number, patch: Partial<(typeof proof)[number]>) =>
    onChange({ ...v, proof: proof.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <div className="space-y-6">
      <Field label={t('Products or services')} fromWebsite={fromWebsite?.has('offer.offers')}>
        <div className="space-y-3">
          {offers.map((o, i) => (
            <div key={i} className="rounded-xl border border-border/70 bg-card/40 p-3 space-y-2">
              <div className="flex gap-2">
                <input className="input" aria-label={t('Product or service name')} placeholder={t('Name, e.g. Export-grade fruit boxes')} value={o.name} maxLength={150} onChange={(e) => setOffer(i, { name: e.target.value })} />
                <button type="button" className="btn-ghost px-2" aria-label={t('Remove {name}', { name: o.name || t('this offer') })} onClick={() => onChange({ ...v, offers: offers.filter((_, j) => j !== i) })}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <input className="input" aria-label={t('Short description')} placeholder={t('What it is, in one line')} value={o.description ?? ''} maxLength={600} onChange={(e) => setOffer(i, { description: e.target.value })} />
              <input className="input" aria-label={t('Typical buyer')} placeholder={t('Typical buyer, e.g. fruit exporters shipping to Europe')} value={o.typical_buyer ?? ''} maxLength={300} onChange={(e) => setOffer(i, { typical_buyer: e.target.value })} />
            </div>
          ))}
          {offers.length < 10 && (
            <button type="button" className="btn-secondary" onClick={() => onChange({ ...v, offers: [...offers, { name: '' }] })}>
              <Plus className="h-4 w-4" />{' '}{t('Add a product or service')}
            </button>
          )}
        </div>
      </Field>
      <Field label={t('Why customers choose you')} htmlFor="p-vp">
        <textarea id="p-vp" className="input min-h-[80px]" value={v.value_proposition ?? ''} maxLength={1500} onChange={(e) => onChange({ ...v, value_proposition: e.target.value })} />
      </Field>
      <Field
        label={t('Proof')}
        fromWebsite={fromWebsite?.has('offer.proof')}
        hint={t('Tick what the AI may mention. Unticked items are never sent to the AI.')}
      >
        <div className="space-y-2">
          {proof.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--primary))]"
                checked={p.may_mention}
                onChange={(e) => setProof(i, { may_mention: e.target.checked })}
                aria-label={t('The AI may mention: {proof}', { proof: p.text || t('this proof') })}
              />
              <input className="input" aria-label={t('Proof point')} placeholder={t('e.g. ISO 22000 certified plant')} value={p.text} maxLength={300} onChange={(e) => setProof(i, { text: e.target.value })} />
              <button type="button" className="btn-ghost px-2" aria-label={t('Remove this proof point')} onClick={() => onChange({ ...v, proof: proof.filter((_, j) => j !== i) })}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          {proof.length < 15 && (
            <button type="button" className="btn-secondary" onClick={() => onChange({ ...v, proof: [...proof, { text: '', may_mention: true }] })}>
              <Plus className="h-4 w-4" />{' '}{t('Add proof')}
            </button>
          )}
        </div>
      </Field>
      <Field label={t('Prices in messages')}>
        <Segmented
          name={t('Prices in messages')}
          options={['never', 'starting_price'] as const}
          value={v.price_policy ?? 'never'}
          onChange={(x) => onChange({ ...v, price_policy: x })}
          labels={{ never: t('Never mention prices'), starting_price: t('May offer to share pricing') }}
        />
      </Field>
    </div>
  );
}

// ── Ideal customers ──────────────────────────────────────────────────────

export function CustomersForm({ value: v, onChange }: SectionProps<CustomersSection>): React.ReactElement {
  const set = <K extends keyof CustomersSection>(k: K, x: CustomersSection[K]) => onChange({ ...v, [k]: x });
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Field label={t('Industries')} htmlFor="p-ind">
          <TagInput id="p-ind" values={v.industries ?? []} onChange={(x) => set('industries', x)} max={15} placeholder={t('e.g. Fruit exporters')} />
        </Field>
        <Field label={t('Who to contact')} htmlFor="p-roles">
          <TagInput id="p-roles" values={v.roles ?? []} onChange={(x) => set('roles', x)} max={15} placeholder={t('e.g. Head of Procurement')} />
        </Field>
      </div>
      <Field label={t('Company size')}>
        <ToggleChips options={COMPANY_SIZES} values={v.company_sizes ?? []} onChange={(x) => set('company_sizes', x)} labels={SIZE_LABELS} />
      </Field>
      <Field label={t('Countries')}>
        <CountriesPicker values={v.countries ?? []} onChange={(x) => set('countries', x)} />
      </Field>
      <Field label={t('Problems they have that you solve')} htmlFor="p-prob">
        <textarea id="p-prob" className="input min-h-[70px]" value={v.problems ?? ''} maxLength={1500} onChange={(e) => set('problems', e.target.value)} />
      </Field>
      <Field label={t('Signals they\'re ready to buy')} hint={t('Prospects showing these are contacted first.')}>
        <ToggleChips options={SIGNALS} values={v.signals ?? []} onChange={(x) => set('signals', x)} labels={SIGNAL_LABELS} />
      </Field>
      <Field
        label={t('Never contact')}
        htmlFor="p-never"
        hint={t('Existing customers, competitors, partners. One per line: a domain (acme.com), an email, or a company name. Checked when finding prospects, importing lists and sending.')}
      >
        <textarea
          id="p-never"
          className="input min-h-[100px] font-mono text-xs"
          value={(v.never_contact ?? []).join('\n')}
          onChange={(e) => set('never_contact', e.target.value.split('\n'))}
          placeholder={t('grupoandino.pe\ncompetitor-pack.com')}
        />
      </Field>
    </div>
  );
}

// ── Voice and sender ─────────────────────────────────────────────────────

export function VoiceForm({ value: v, onChange }: SectionProps<VoiceSection>): React.ReactElement {
  const set = <K extends keyof VoiceSection>(k: K, x: VoiceSection[K]) => onChange({ ...v, [k]: x });
  return (
    <div className="space-y-6">
      <Field label={t('Tone')}>
        <Segmented name="Tone" options={TONES} value={v.tone ?? 'professional'} onChange={(x) => set('tone', x)} labels={TONE_LABELS} />
      </Field>
      <Field label={t('Formality in languages that have it')}>
        <Segmented
          name="Formality"
          options={['formal', 'informal'] as const}
          value={v.formality ?? 'formal'}
          onChange={(x) => set('formality', x)}
          labels={{ formal: t('Formal (usted, Sie, vous)'), informal: t('Informal (tú, du, tu)') }}
        />
      </Field>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Field label={t('Sender name')} htmlFor="p-sn">
          <input id="p-sn" className="input" value={v.sender_name ?? ''} maxLength={120} onChange={(e) => set('sender_name', e.target.value)} placeholder={t('Ana Torres')} />
        </Field>
        <Field label={t('Sender title')} htmlFor="p-st">
          <input id="p-st" className="input" value={v.sender_title ?? ''} maxLength={120} onChange={(e) => set('sender_title', e.target.value)} placeholder={t('Export Sales Lead')} />
        </Field>
        <Field label={t('Meeting link')} htmlFor="p-ml" hint={t('Added to emails and WhatsApp messages that ask for a meeting.')}>
          <input id="p-ml" className="input" type="url" value={v.meeting_link ?? ''} maxLength={500} onChange={(e) => set('meeting_link', e.target.value)} placeholder="https://calendly.com/you/15min" />
        </Field>
        <Field label={t('Words or claims to avoid')} htmlFor="p-avoid">
          <TagInput id="p-avoid" values={v.avoid ?? []} onChange={(x) => set('avoid', x)} max={30} placeholder={t('cheapest, guaranteed')} />
        </Field>
      </div>
      <Field label={t('A message you\'ve sent that worked (optional)')} htmlFor="p-ex" hint={t('The AI copies its style, never its facts.')}>
        <textarea id="p-ex" className="input min-h-[90px]" value={v.example ?? ''} maxLength={3000} onChange={(e) => set('example', e.target.value)} placeholder={t('Paste it here.')} />
      </Field>
    </div>
  );
}

// ── Rules ────────────────────────────────────────────────────────────────

export function RulesForm({ value: v, onChange }: SectionProps<RulesSection>): React.ReactElement {
  const hours = v.contact_hours;
  const bad = !!hours && hours.start >= hours.end;
  return (
    <div className="space-y-6">
      <Field label={t('Countries never to contact')} hint={t('Prospects and imported leads in these countries are skipped.')}>
        <CountriesPicker values={v.blocked_countries ?? []} onChange={(x) => onChange({ ...v, blocked_countries: x })} max={250} />
      </Field>
      <div>
        <label className="flex items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[hsl(var(--primary))]"
            checked={!!hours}
            onChange={(e) =>
              onChange({ ...v, contact_hours: e.target.checked ? { start: '09:00', end: '19:00', weekdays_only: true } : undefined })
            }
          />
          {t('Only message people during their working day')}
        </label>
        {hours && (
          <div className="mt-3 space-y-3 ps-6">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                {t('From')}
                <input type="time" className="input w-auto py-1.5" value={hours.start} aria-label={t('Contact hours start')}
                  onChange={(e) => onChange({ ...v, contact_hours: { ...hours, start: e.target.value } })} />
              </label>
              <label className="flex items-center gap-2 text-sm">
                {t('Until')}
                <input type="time" className="input w-auto py-1.5" value={hours.end} aria-label={t('Contact hours end')}
                  onChange={(e) => onChange({ ...v, contact_hours: { ...hours, end: e.target.value } })} />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" checked={hours.weekdays_only}
                onChange={(e) => onChange({ ...v, contact_hours: { ...hours, weekdays_only: e.target.checked } })} />
              {t('Working days only')}
            </label>
            {bad && <p role="alert" className="text-xs text-destructive">{t('The end time must be later than the start time.')}</p>}
          </div>
        )}
        <p className="mt-2 ps-6 text-xs text-muted-foreground">
          {t('This is the prospect\'s local time, worked out from their country. Messages outside it wait in the queue and go out when the window opens. The weekend is Friday and Saturday in Saudi Arabia, Qatar, Kuwait, Bahrain, Oman, Egypt and Jordan, and Saturday and Sunday elsewhere.')}
        </p>
      </div>
    </div>
  );
}
