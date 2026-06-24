/**
 * 4-step campaign wizard shell — progress bar, step navigation,
 * validation, and submit.
 *
 * Two modes:
 *   - 'create' (default): wires Save-as-Draft and Launch mutations
 *   - 'edit'           : wires PATCH /api/campaigns/:id, swaps the
 *                         primary CTA to "Save changes" and removes
 *                         the Launch path (use the campaign card's
 *                         Pause/Resume after saving instead)
 *
 * Both modes share the same UI; the only differences are the mutation
 * called on submit and the button labels at the Review step.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import clsx from 'clsx';

import {
  useCreateCampaign,
  useLaunchCampaign,
  useUpdateCampaign,
} from '../../hooks/useCampaigns';

import StepBasics from './StepBasics';
import StepICP from './StepICP';
import StepReview from './StepReview';
import StepSequence from './StepSequence';
import { INITIAL_DRAFT, type WizardDraft } from './types';

interface CampaignFormProps {
  /** 'create' (new) or 'edit' (PATCH an existing campaign). */
  mode?: 'create' | 'edit';
  /** Pre-fill values; defaults to INITIAL_DRAFT in create mode. */
  initialDraft?: WizardDraft;
  /** Required when mode='edit' — campaign id to PATCH. */
  editingId?: string;
}

const STEPS = [
  { label: 'Basics', description: 'Name, goal, sender, tone' },
  { label: 'ICP Criteria', description: 'Who to target' },
  { label: 'Sequence', description: 'Channels + cadence' },
  { label: 'Review', description: 'Launch or save' },
];

function validateBasics(draft: WizardDraft): Partial<Record<keyof WizardDraft, string>> {
  const errors: Partial<Record<keyof WizardDraft, string>> = {};
  if (!draft.name.trim()) errors.name = 'required';
  if (!draft.sender_name.trim()) errors.sender_name = 'required';
  if (!draft.sender_company.trim()) errors.sender_company = 'required';
  if (!draft.value_proposition.trim()) errors.value_proposition = 'required';
  return errors;
}

function buildPayload(draft: WizardDraft) {
  const goal = draft.goal === 'Custom' ? draft.customGoal || 'Custom' : draft.goal;
  return {
    name: draft.name,
    goal,
    tone: draft.tone,
    sender_company: draft.sender_company,
    sender_name: draft.sender_name,
    value_proposition: draft.value_proposition,
    icp_criteria: {
      industries: draft.industries,
      company_sizes: draft.company_sizes,
      countries: draft.countries,
      titles: draft.titles,
      intent_keywords: draft.intent_keywords,
    },
    sequence_steps: draft.sequence.map((s, idx) => ({
      step_number: idx + 1,
      channel: s.channel,
      action: s.action || 'send',
      delay_days: Math.max(0, s.day - 1),
    })),
    daily_limits: draft.daily_limits,
    batch_size: draft.batch_size,
    heyreach_campaign_id: draft.heyreach_campaign_id ?? null,
  };
}

export default function CampaignForm({
  mode = 'create',
  initialDraft,
  editingId,
}: CampaignFormProps = {}) {
  const isEdit = mode === 'edit';
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<WizardDraft>(
    initialDraft ?? INITIAL_DRAFT,
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const navigate = useNavigate();
  const create = useCreateCampaign();
  const launch = useLaunchCampaign();
  const update = useUpdateCampaign();

  const basicsErrors = useMemo(() => validateBasics(draft), [draft]);

  function patch(p: Partial<WizardDraft>) {
    setDraft((prev) => ({ ...prev, ...p }));
  }

  function goNext() {
    if (step === 0 && Object.keys(basicsErrors).length > 0) return;
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  }
  function goBack() {
    setStep((s) => Math.max(0, s - 1));
  }

  async function onSaveDraft() {
    setSubmitError(null);
    try {
      const payload = buildPayload(draft);
      if (isEdit && editingId) {
        // Edit-mode submit: PATCH the existing campaign.
        await update.mutateAsync({ id: editingId, patch: payload });
        navigate(`/campaigns?updated=${editingId}`);
      } else {
        const created = await create.mutateAsync(payload);
        navigate(`/?drafted=${created.id}`);
      }
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  }

  async function onLaunch() {
    setSubmitError(null);
    try {
      const payload = buildPayload(draft);
      if (isEdit && editingId) {
        // In edit mode, "Save and launch" doesn't apply — campaigns
        // launch separately via the dashboard cards. Treat as plain save.
        await update.mutateAsync({ id: editingId, patch: payload });
        navigate(`/campaigns?updated=${editingId}`);
        return;
      }
      const created = await create.mutateAsync(payload);
      await launch.mutateAsync(created.id);
      navigate(`/?launched=${created.id}`);
    } catch (err) {
      setSubmitError((err as Error).message);
    }
  }

  const busy = create.isPending || launch.isPending || update.isPending;

  return (
    <div className="space-y-6">
      {/* Progress */}
      <div className="card">
        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => {
            const done = i < step;
            const active = i === step;
            return (
              <div key={s.label} className="flex-1">
                <div
                  className={clsx(
                    'h-1.5 rounded-full',
                    done || active ? 'bg-brand' : 'bg-slate-200',
                  )}
                />
                <div className="mt-2 flex items-center gap-2">
                  <div
                    className={clsx(
                      'w-5 h-5 rounded-full text-[10px] flex items-center justify-center font-semibold',
                      done
                        ? 'bg-brand text-white'
                        : active
                          ? 'bg-brand-light text-brand border border-brand'
                          : 'bg-slate-100 text-slate-400',
                    )}
                  >
                    {i + 1}
                  </div>
                  <div>
                    <div
                      className={clsx(
                        'text-sm font-medium',
                        active ? 'text-slate-800' : 'text-slate-500',
                      )}
                    >
                      {s.label}
                    </div>
                    <div className="text-[11px] text-slate-400">{s.description}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Step body */}
      <div className="card">
        {step === 0 && <StepBasics draft={draft} onChange={patch} errors={basicsErrors} />}
        {step === 1 && <StepICP draft={draft} onChange={patch} />}
        {step === 2 && <StepSequence draft={draft} onChange={patch} />}
        {step === 3 && (
          <StepReview
            draft={draft}
            onChange={patch}
            onSaveDraft={onSaveDraft}
            onLaunch={onLaunch}
            busy={busy}
            error={submitError}
            mode={mode}
          />
        )}
      </div>

      {/* Nav */}
      {step < STEPS.length - 1 && (
        <div className="flex justify-between">
          <button className="btn-ghost" onClick={goBack} disabled={step === 0}>
            ← Back
          </button>
          <button
            className="btn-primary"
            onClick={goNext}
            disabled={step === 0 && Object.keys(basicsErrors).length > 0}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
