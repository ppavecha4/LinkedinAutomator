/**
 * Prospect Pipeline page — filterable prospect table.
 *
 * The current API exposes prospects only under `/api/campaigns/:id/prospects`,
 * so the page REQUIRES a campaign selector (via ?campaign=). A global
 * /api/prospects?filter=... endpoint is a later session — tracked in
 * project memory.
 */

import { Filter, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import ConversationViewer from '../components/ConversationViewer';
import ProspectTable from '../components/ProspectTable';
import { PageHeader } from '../components/ui/page-header';
import { useCampaignProspects, useCampaigns } from '../hooks/useCampaigns';
import type { Contact, PitchType, Prospect, ProspectStatus } from '../lib/types';

const STATUS_OPTIONS: Array<ProspectStatus | 'ALL'> = [
  'ALL',
  'DISCOVERED',
  'ENRICHED',
  'CONTACTED',
  'REPLIED',
  'MEETING_BOOKED',
  'UNSUBSCRIBED',
];

const PITCH_OPTIONS: Array<PitchType | 'ALL'> = [
  'ALL',
  'ai_agents',
  'rpa_workflow',
  'consulting',
];

export default function ProspectPipeline() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: campaigns } = useCampaigns();
  const campaignId = searchParams.get('campaign') ?? campaigns?.[0]?.id;

  const [status, setStatus] = useState<ProspectStatus | 'ALL'>('ALL');
  const [pitch, setPitch] = useState<PitchType | 'ALL'>('ALL');
  const [country, setCountry] = useState('');
  const [industry, setIndustry] = useState('');

  const [selected, setSelected] = useState<{
    prospect: Prospect;
    contact: Contact | null;
  } | null>(null);

  const { data: prospects, isLoading } = useCampaignProspects(campaignId ?? undefined);

  const filtered = useMemo(() => {
    return (prospects ?? []).filter((p) => {
      if (status !== 'ALL' && p.status !== status) return false;
      if (pitch !== 'ALL' && p.pitch_type !== pitch) return false;
      if (country && (p.country ?? '').toLowerCase().indexOf(country.toLowerCase()) === -1)
        return false;
      if (industry && (p.industry ?? '').toLowerCase().indexOf(industry.toLowerCase()) === -1)
        return false;
      return true;
    });
  }, [prospects, status, pitch, country, industry]);

  return (
    <div>
      <PageHeader
        eyebrow="Pipeline"
        title="Prospects"
        description="Every discovered and enriched contact across your campaigns. Filter by campaign, stage, pitch, country, industry."
        icon={Users}
      />

      {/* Filters — glass panel */}
      <div className="glass rounded-2xl p-5 mb-6">
        <div className="flex items-center gap-2 mb-4 text-sm font-semibold text-muted-foreground">
          <Filter className="h-4 w-4" />
          Filters
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="label">Campaign</label>
            <select
              className="input"
              value={campaignId ?? ''}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams);
                next.set('campaign', e.target.value);
                setSearchParams(next);
              }}
            >
              {(campaigns ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProspectStatus | 'ALL')}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Pitch</label>
            <select
              className="input"
              value={pitch}
              onChange={(e) => setPitch(e.target.value as PitchType | 'ALL')}
            >
              {PITCH_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Country contains</label>
            <input
              className="input"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="US, India…"
            />
          </div>
          <div>
            <label className="label">Industry contains</label>
            <input
              className="input"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              placeholder="SaaS, Logistics…"
            />
          </div>
        </div>
      </div>

      {isLoading && <div className="glass rounded-2xl h-40 animate-shimmer" />}
      {!isLoading && !campaignId && (
        <div className="glass rounded-2xl text-center text-sm text-muted-foreground py-12 bg-grid-subtle">
          Create a campaign first to see prospects.
        </div>
      )}
      {!isLoading && campaignId && (
        <div className="glass rounded-2xl overflow-hidden">
          <ProspectTable
            prospects={filtered}
            onRowClick={(p, c) => setSelected({ prospect: p, contact: c })}
          />
        </div>
      )}

      <ConversationViewer
        open={!!selected}
        onClose={() => setSelected(null)}
        contact={selected?.contact ?? null}
        prospect={selected?.prospect ?? null}
      />
    </div>
  );
}
