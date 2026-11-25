/**
 * CampaignPlanner — the "you only approve" campaign builder.
 *
 * The operator types a plain-English goal. The orchestrator proposes a
 * COMPLETE campaign (ICP, channels, sequence, cadence, positioning) with
 * a rationale. The operator reviews and either:
 *   - Approve & Launch  → create the campaign + launch immediately
 *   - Save as Draft     → create it in DRAFT to edit/launch later
 *
 * The proposal maps 1:1 to the create-campaign payload, so approval is a
 * straight POST /api/campaigns.
 */

import { Loader2, Rocket, Sparkles, Wand2 } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { PageHeader } from '../components/ui/page-header';
import {
  usePlanCampaign,
  useCreateCampaign,
  useLaunchCampaign,
  type CampaignPlan,
} from '../hooks/useCampaigns';

const CHANNEL_EMOJI: Record<string, string> = {
  email: '📧',
  linkedin: '💼',
  whatsapp: '💬',
};

const EXAMPLES = [
  'Book discovery calls with CTOs at Series A-C US fintechs hiring backend engineers',
  'Get staff-augmentation deals with engineering leaders at UK & German SaaS scale-ups',
  'Reach heads of IT at mid-market manufacturers in India needing SAP/Salesforce contractors',
];

export default function CampaignPlanner(): React.ReactElement {
  const [goal, setGoal] = React.useState('');
  const [plan, setPlan] = React.useState<CampaignPlan | null>(null);

  const planner = usePlanCampaign();
  const create = useCreateCampaign();
  const launch = useLaunchCampaign();
  const navigate = useNavigate();

  const generate = async () => {
    if (goal.trim().length < 5) return;
    setPlan(null);
    try {
      const p = await planner.mutateAsync({
        goal: goal.trim(),
        sender_name: 'Prateek Pavecha',
        sender_company: 'Appson AI',
      });
      setPlan(p);
    } catch (e) {
      toast.error('Planning failed', { description: (e as Error).message });
    }
  };

  const toPayload = (p: CampaignPlan) => ({
    name: p.name,
    goal: p.goal,
    tone: p.tone,
    sender_company: p.sender_company || 'Appson AI',
    sender_name: p.sender_name || 'Prateek Pavecha',
    value_proposition: p.value_proposition,
    icp_criteria: p.icp_criteria,
    sequence_steps: p.sequence_steps,
    daily_limits: p.daily_limits,
    batch_size: p.batch_size,
  });

  const approve = async (thenLaunch: boolean) => {
    if (!plan) return;
    try {
      const created = await create.mutateAsync(toPayload(plan));
      if (thenLaunch) {
        await launch.mutateAsync(created.id);
        toast.success('Campaign approved & launched');
        navigate(`/?launched=${created.id}`);
      } else {
        toast.success('Saved as draft');
        navigate(`/campaigns/${created.id}/edit`);
      }
    } catch (e) {
      toast.error('Approval failed', { description: (e as Error).message });
    }
  };

  const busy = create.isPending || launch.isPending;

  return (
    <div>
      <PageHeader
        eyebrow="AI planner"
        title="Plan a campaign"
        description="Describe your goal. The orchestrator designs the full campaign — you just approve."
        icon={Wand2}
      />

      {/* Goal input */}
      <div className="card mb-6">
        <label className="text-sm font-medium text-slate-700">
          What do you want this campaign to achieve?
        </label>
        <textarea
          className="input mt-2 w-full min-h-[90px] text-sm"
          placeholder="e.g. Book discovery calls with CTOs at US fintech startups hiring engineers…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setGoal(ex)}
              className="text-[11px] px-2 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"
            >
              {ex.slice(0, 52)}…
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            className="btn-primary"
            onClick={generate}
            disabled={planner.isPending || goal.trim().length < 5}
          >
            {planner.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {planner.isPending ? 'Designing…' : 'Generate plan'}
          </button>
        </div>
      </div>

      {planner.isPending && (
        <div className="card text-center py-10 text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Researching the market and designing your campaign…
        </div>
      )}

      {/* Proposal */}
      {plan && !planner.isPending && (
        <div className="space-y-4">
          <div className="card border-l-4 border-brand">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-400">
                  Proposed campaign
                </div>
                <h3 className="text-lg font-semibold text-slate-800">
                  {plan.name}
                </h3>
                <div className="text-sm text-slate-500 mt-0.5">{plan.goal}</div>
              </div>
              <span className="shrink-0 text-[11px] px-2 py-1 rounded-full bg-brand-light text-brand capitalize">
                {plan.service_line.replace('_', ' ')}
              </span>
            </div>
            <p className="text-sm text-slate-600 mt-3 leading-relaxed">
              {plan.value_proposition}
            </p>
          </div>

          {/* Rationale */}
          <div className="card bg-amber-50/50 border border-amber-100">
            <div className="text-xs font-semibold text-amber-700 mb-1 uppercase tracking-wide">
              Why this plan
            </div>
            <p className="text-sm text-slate-700 leading-relaxed">
              {plan.rationale}
            </p>
          </div>

          {/* ICP + config grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card">
              <h4 className="text-sm font-semibold text-slate-800 mb-3">
                Target (ICP)
              </h4>
              <Field label="Countries" values={plan.icp_criteria.countries} />
              <Field label="Titles" values={plan.icp_criteria.titles} />
              <Field label="Industries" values={plan.icp_criteria.industries} />
              <Field label="Company size" values={plan.icp_criteria.company_sizes} />
              <Field label="Intent keywords" values={plan.icp_criteria.intent_keywords} />
            </div>

            <div className="card">
              <h4 className="text-sm font-semibold text-slate-800 mb-3">
                Sequence &amp; cadence
              </h4>
              <ol className="space-y-2">
                {plan.sequence_steps.map((s) => (
                  <li key={s.step_number} className="flex items-start gap-2 text-sm">
                    <span className="shrink-0 mt-0.5 text-[11px] font-mono text-slate-400">
                      Day {s.delay_days}
                    </span>
                    <span>{CHANNEL_EMOJI[s.channel] ?? '•'}</span>
                    <span className="text-slate-700">{s.action}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-500 space-y-1">
                <div>
                  Channels:{' '}
                  {plan.channels_enabled
                    .map((c) => `${CHANNEL_EMOJI[c]} ${c}`)
                    .join('  ')}
                </div>
                <div>
                  Daily limits: email {plan.daily_limits.email} · linkedin{' '}
                  {plan.daily_limits.linkedin} · whatsapp{' '}
                  {plan.daily_limits.whatsapp}
                </div>
                <div>Batch size: {plan.batch_size} prospects</div>
              </div>
            </div>
          </div>

          {/* Approve actions */}
          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <button
              className="btn-ghost"
              onClick={() => setPlan(null)}
              disabled={busy}
            >
              Discard
            </button>
            <button
              className="btn-secondary"
              onClick={() => approve(false)}
              disabled={busy}
            >
              Save as draft
            </button>
            <button
              className="btn-primary"
              onClick={() => approve(true)}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Rocket className="h-4 w-4" />
              )}
              Approve &amp; launch
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, values }: { label: string; values: string[] }) {
  if (!values?.length) return null;
  return (
    <div className="mb-2.5">
      <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span
            key={v}
            className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600"
          >
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}
