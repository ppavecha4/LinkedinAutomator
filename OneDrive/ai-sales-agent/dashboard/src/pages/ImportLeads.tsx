/**
 * Upload a lead list into a campaign (SaaS phase 2, slice 2.5), on top of
 * the slice 2.2 import API:
 *   upload → check the column mapping → row-by-row result → consent →
 *   import → launch.
 * The import id lives in the URL (?import=…), so a reload resumes where it
 * was. Launch is offered only once contacts are in: an ACTIVE campaign
 * with no prospects would start AI discovery instead.
 */

import { CheckCircle2, FileSpreadsheet, Loader2, Rocket, Trash2, Upload } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { CountrySelect, Field } from '../components/profile/fields';
import { PageHeader } from '../components/ui/page-header';
import { useOrganization } from '../hooks/useWorkspace';
import { api } from '../lib/api';
import { errorMessage } from '../lib/authContext';
import { cn } from '../lib/cn';
import { takePendingImport } from '../lib/pendingImport';
import { languageName } from '../lib/profile';

type Target =
  | 'full_name' | 'first_name' | 'last_name' | 'company' | 'title' | 'email' | 'phone'
  | 'country' | 'language' | 'linkedin_url' | 'company_domain' | 'industry' | 'note' | 'ignore';

const TARGET_LABELS: Record<Target, string> = {
  full_name: 'Full name', first_name: 'First name', last_name: 'Last name', company: 'Company',
  title: 'Job title', email: 'Email', phone: 'Phone / WhatsApp', country: 'Country', language: 'Language',
  linkedin_url: 'LinkedIn URL', company_domain: 'Company website', industry: 'Industry',
  note: 'Note (for personalising)', ignore: "Don't import",
};
const TARGETS = Object.keys(TARGET_LABELS) as Target[];

const PROBLEM_LABELS: Record<string, string> = {
  missing_name: 'No name', no_contact_method: 'No email or phone', invalid_email: 'Email not valid',
  invalid_phone: 'Phone not valid', unknown_country: "Country not recognised", unknown_language: 'Language not recognised',
  duplicate_in_file: 'Duplicate in this file', already_a_contact: 'Already one of your contacts',
  opted_out: 'Opted out earlier', never_contact: 'On your never-contact list', blocked_country: 'In a blocked country',
};

interface LeadImport {
  id: string;
  campaign_id: string;
  file_name: string;
  sheet_name: string | null;
  headers: string[];
  column_mapping: Target[];
  default_country: string | null;
  status: 'UPLOADED' | 'VALIDATED' | 'IMPORTED' | 'CANCELLED' | string;
  total_rows: number;
  ready_rows: number;
  duplicate_rows: number;
  invalid_rows: number;
  suppressed_rows: number;
  imported_rows: number;
  languages: Record<string, number>;
}

interface Row {
  row_number: number;
  raw: string[];
  status: string;
  problems: string[];
}

export default function ImportLeads(): React.ReactElement {
  const { id: campaignId } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const importId = params.get('import');
  const [imp, setImp] = React.useState<LeadImport | null>(null);
  const [samples, setSamples] = React.useState<string[][]>([]);
  const [basis, setBasis] = React.useState<string[]>([]);
  const [campaign, setCampaign] = React.useState<{ name: string; status: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const started = React.useRef(false);

  // Campaign name + status for the header and the launch step.
  React.useEffect(() => {
    api.get<{ campaign: { name: string; status: string } }>(`/api/campaigns/${campaignId}`)
      .then(({ data }) => setCampaign(data.campaign))
      .catch((e) => setError(errorMessage(e, 'Could not load the campaign.')));
  }, [campaignId]);

  const upload = React.useCallback(async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const { data } = await api.upload<{ import: LeadImport; sample_rows: string[][]; mapping_basis: string[] }>(
        `/api/campaigns/${campaignId}/imports?filename=${encodeURIComponent(file.name)}`, file);
      setImp(data.import);
      setSamples(data.sample_rows);
      setBasis(data.mapping_basis);
      setParams({ import: data.import.id }, { replace: true });
    } catch (e) {
      setError(errorMessage(e, 'Could not read that file.'));
    } finally {
      setUploading(false);
    }
  }, [campaignId, setParams]);

  // Resume an import from the URL, or upload the file the wizard handed over.
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (importId) {
      Promise.all([
        api.get<LeadImport>(`/api/imports/${importId}`),
        api.get<Row[]>(`/api/imports/${importId}/rows?limit=5`),
      ]).then(([i, r]) => {
        setImp(i.data);
        setSamples(r.data.map((x) => x.raw));
      }).catch((e) => setError(errorMessage(e, 'Could not load this import.')));
      return;
    }
    const pending = campaignId ? takePendingImport(campaignId) : null;
    if (pending) void upload(pending);
  }, [importId, campaignId, upload]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Campaigns"
        title="Upload your list"
        description={campaign ? `Into "${campaign.name}". Check how we read your file before anything is imported.` : 'Check how we read your file before anything is imported.'}
        icon={FileSpreadsheet}
      />
      <div className="max-w-4xl space-y-6">
        {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
        {!imp ? (
          uploading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading your file…</p>
          ) : importId && !error ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
          ) : (
            <UploadBox onFile={upload} />
          )
        ) : imp.status === 'IMPORTED' ? (
          <Done imp={imp} campaignId={campaignId!} campaign={campaign} onCampaign={setCampaign} />
        ) : imp.status === 'CANCELLED' ? (
          <p className="text-sm">This import was cancelled. <button type="button" className="underline" onClick={() => { setImp(null); setParams({}); }}>Upload another file</button></p>
        ) : (
          <MappingAndCheck imp={imp} samples={samples} basis={basis} onImp={setImp}
            onCancelled={() => { setImp(null); setParams({}); }} />
        )}
      </div>
    </div>
  );
}

function UploadBox({ onFile }: { onFile: (f: File) => void }): React.ReactElement {
  const [problem, setProblem] = React.useState<string | null>(null);
  const accept = (f: File | undefined) => {
    setProblem(null);
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) return setProblem('Choose an .xlsx or .csv file.');
    if (f.size > 10 * 1024 * 1024) return setProblem('That file is larger than 10 MB.');
    onFile(f);
  };
  return (
    <div>
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); accept(e.dataTransfer.files[0]); }}
        className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border/80 p-10 text-center hover:border-primary/60"
      >
        <Upload className="h-8 w-8 text-primary" aria-hidden="true" />
        <span className="text-sm"><span className="font-medium">Drop an .xlsx or .csv file here</span> or browse your files</span>
        <span className="text-xs text-muted-foreground">Up to 10,000 rows and 10 MB. Headers can be in any language.</span>
        <input type="file" accept=".xlsx,.csv" className="sr-only" onChange={(e) => accept(e.target.files?.[0])} />
      </label>
      {problem && <p className="mt-2 text-sm text-destructive">{problem}</p>}
    </div>
  );
}

function MappingAndCheck({ imp, samples, basis, onImp, onCancelled }: {
  imp: LeadImport; samples: string[][]; basis: string[];
  onImp: (i: LeadImport) => void; onCancelled: () => void;
}): React.ReactElement {
  const org = useOrganization();
  const [mapping, setMapping] = React.useState<Target[]>(imp.column_mapping);
  const [country, setCountry] = React.useState<string | undefined>(imp.default_country ?? undefined);
  const [validated, setValidated] = React.useState(imp.status === 'VALIDATED');
  const [consentText, setConsentText] = React.useState<string | null>(null);
  const [consent, setConsent] = React.useState(false);
  const [busy, setBusy] = React.useState<null | 'check' | 'import' | 'cancel'>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!country && org.data?.default_country) setCountry(org.data.default_country);
  }, [org.data, country]);

  const setTarget = (i: number, t: Target) => {
    setMapping(mapping.map((m, j) => (j === i ? t : m)));
    setValidated(false); // the counts below are stale until checked again
    setConsent(false);
  };

  async function check() {
    setError(null);
    setBusy('check');
    try {
      const { data } = await api.put<{ import: LeadImport; consent_text: string }>(`/api/imports/${imp.id}/mapping`, {
        mapping,
        default_country: country ?? null,
      });
      onImp(data.import);
      setConsentText(data.consent_text);
      setValidated(true);
    } catch (e) {
      setError(errorMessage(e, 'Could not check the rows.'));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    setError(null);
    setBusy('import');
    try {
      const { data } = await api.post<LeadImport>(`/api/imports/${imp.id}/commit`, { consent: true });
      onImp(data);
    } catch (e) {
      setError(errorMessage(e, 'Could not import.'));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy('cancel');
    try {
      await api.delete(`/api/imports/${imp.id}`);
      toast.success('Import cancelled; its rows were deleted');
      onCancelled();
    } catch (e) {
      setError(errorMessage(e, 'Could not cancel.'));
      setBusy(null);
    }
  }

  const used = mapping.filter((m) => m !== 'note' && m !== 'ignore');
  const dupTarget = used.find((m, i) => used.indexOf(m) !== i);

  return (
    <div className="space-y-6">
      <section className="glass rounded-2xl p-5">
        <h2 className="text-base font-semibold">Check how we read your file</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {imp.file_name}{imp.sheet_name ? ` · sheet "${imp.sheet_name}"` : ''} · {imp.total_rows} rows. Change any column we matched wrongly.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Column in your file</th>
                <th className="py-2 pr-3 font-semibold">Example</th>
                <th className="py-2 font-semibold">Use it as</th>
              </tr>
            </thead>
            <tbody>
              {imp.headers.map((h, i) => (
                <tr key={i} className="border-t border-border/50">
                  <td className="py-2 pr-3 font-medium">{h || <span className="text-muted-foreground">(no header)</span>}</td>
                  <td className="max-w-[16rem] truncate py-2 pr-3 text-muted-foreground">{samples.find((r) => r[i])?.[i] ?? '—'}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <select aria-label={`Use column ${h} as`} className="input py-1.5" value={mapping[i]} onChange={(e) => setTarget(i, e.target.value as Target)}>
                        {TARGETS.map((t) => <option key={t} value={t}>{TARGET_LABELS[t]}</option>)}
                      </select>
                      {basis[i] && basis[i] !== 'none' && mapping[i] === imp.column_mapping[i] && (
                        <span className="shrink-0 text-[11px] text-muted-foreground">{basis[i] === 'header' ? 'from header' : 'from values'}</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Country for rows without one" htmlFor="im-country" hint="Used to read local phone numbers and pick a language.">
            <CountrySelect id="im-country" value={country} onChange={(c) => { setCountry(c); setValidated(false); }} />
          </Field>
        </div>
        {dupTarget && <p className="mt-3 text-sm text-destructive">Two columns are set to "{TARGET_LABELS[dupTarget]}". Each field can come from one column only.</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className={validated ? 'btn-secondary' : 'btn-primary'} onClick={check} disabled={!!busy || !!dupTarget}>
            {busy === 'check' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {validated ? 'Check again' : 'Check the rows'}
          </button>
          <button type="button" className="btn-ghost text-destructive" onClick={cancel} disabled={!!busy}>
            <Trash2 className="h-4 w-4" aria-hidden="true" /> Cancel import
          </button>
        </div>
      </section>

      {validated && (
        <>
          <Results imp={imp} />
          <section className="glass rounded-2xl p-5 space-y-4">
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>{consentText ?? 'I confirm that my organization has a lawful basis to contact the people in this file, including their opt-in to WhatsApp messages where the law requires it, and that none of them has asked us not to contact them.'}</span>
            </label>
            <button type="button" className="btn-primary" onClick={commit} disabled={!consent || !!busy || imp.ready_rows === 0}>
              {busy === 'import' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Import {imp.ready_rows} contact{imp.ready_rows === 1 ? '' : 's'}
            </button>
          </section>
        </>
      )}
      {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}

function Results({ imp }: { imp: LeadImport }): React.ReactElement {
  const [show, setShow] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function open(status: string) {
    if (show === status) return setShow(null);
    setShow(status);
    setRows(null);
    setLoading(true);
    try {
      setRows((await api.get<Row[]>(`/api/imports/${imp.id}/rows?status=${status}&limit=100`)).data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  const lines: Array<[string, string, number, string]> = [
    ['READY', 'Ready to import', imp.ready_rows, 'text-emerald-600 dark:text-emerald-400'],
    ['DUPLICATE', 'Duplicates (in the file or already yours)', imp.duplicate_rows, ''],
    ['INVALID', 'Missing a name or a way to reach them', imp.invalid_rows, ''],
    ['SUPPRESSED', 'Skipped: opted out, never-contact list or blocked country', imp.suppressed_rows, ''],
  ];
  const langs = Object.entries(imp.languages ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <section className="glass rounded-2xl p-5">
      <h2 className="text-base font-semibold">What will be imported</h2>
      <ul className="mt-3 divide-y divide-border/50 text-sm">
        {lines.map(([status, label, n, cls]) => (
          <li key={status}>
            <button type="button" className="flex w-full items-center justify-between py-2 text-left disabled:cursor-default" disabled={n === 0} onClick={() => open(status)} aria-expanded={show === status}>
              <span>{label}</span>
              <span className={cn('font-semibold tabular-nums', cls)}>{n}</span>
            </button>
            {show === status && (
              <div className="pb-3">
                {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading rows" /> : (
                  <ul className="max-h-64 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                    {(rows ?? []).map((r) => (
                      <li key={r.row_number}>
                        Row {r.row_number + 1}: {r.raw.filter(Boolean).slice(0, 3).join(' · ')}
                        {r.problems.length ? <span className="text-foreground"> — {r.problems.map((p) => PROBLEM_LABELS[p] ?? p).join(', ')}</span> : null}
                      </li>
                    ))}
                    {rows && rows.length === 100 && <li>Showing the first 100.</li>}
                  </ul>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {langs.length > 0 && (
        <p className="mt-3 text-sm">
          <span className="text-muted-foreground">Languages found: </span>
          {langs.map(([l, n]) => `${l === 'unknown' ? 'Not given (from their country)' : languageName(l)} · ${n}`).join(', ')}
        </p>
      )}
    </section>
  );
}

function Done({ imp, campaignId, campaign, onCampaign }: {
  imp: LeadImport; campaignId: string; campaign: { name: string; status: string } | null;
  onCampaign: (c: { name: string; status: string }) => void;
}): React.ReactElement {
  const navigate = useNavigate();
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  async function launch() {
    setBusy(true);
    setProblem(null);
    try {
      const { data } = await api.patch<{ name: string; status: string }>(`/api/campaigns/${campaignId}/status`, { status: 'ACTIVE' });
      onCampaign(data);
      toast.success('Campaign launched', { description: 'The agent researches and writes to each contact.' });
      navigate('/campaigns');
    } catch (e) {
      setProblem(errorMessage(e, 'Could not launch.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass rounded-2xl p-6 space-y-4">
      <div className="flex items-center gap-3">
        <CheckCircle2 className="h-6 w-6 text-emerald-500" aria-hidden="true" />
        <h2 className="text-lg font-semibold">{imp.imported_rows} contact{imp.imported_rows === 1 ? '' : 's'} imported</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Once the campaign is live, the agent researches each contact and writes to them in their language, on the channels the campaign uses.
      </p>
      {problem && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {problem}. <Link className="underline" to="/settings/connections">Open connected accounts</Link>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {campaign?.status === 'DRAFT' && imp.imported_rows > 0 && (
          <button type="button" className="btn-primary" onClick={launch} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
            Launch campaign
          </button>
        )}
        <Link to="/campaigns" className="btn-secondary">Go to campaigns</Link>
      </div>
    </section>
  );
}
