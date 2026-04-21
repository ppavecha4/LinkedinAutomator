/**
 * Step 3 — channels, sequence table, daily limits, batch size.
 */

import clsx from 'clsx';

import type { Channel } from '../../lib/types';

import type { WizardDraft, WizardSequenceStep } from './types';

interface Props {
  draft: WizardDraft;
  onChange: (patch: Partial<WizardDraft>) => void;
}

const CHANNEL_INFO: Record<
  Channel,
  { label: string; icon: string; note: string }
> = {
  email: {
    label: 'Email',
    icon: '📧',
    note: 'SES — bounce + complaint webhooks wired, suppression enforced.',
  },
  linkedin: {
    label: 'LinkedIn',
    icon: '💼',
    note: 'Partner API — 280-char connection note, daily quota enforced.',
  },
  whatsapp: {
    label: 'WhatsApp',
    icon: '💬',
    note: 'Twilio Business API — opted-in templates only outside 24h window.',
  },
};

const CHANNEL_ORDER: Channel[] = ['email', 'linkedin', 'whatsapp'];

function updateStep(
  sequence: WizardSequenceStep[],
  index: number,
  patch: Partial<WizardSequenceStep>,
): WizardSequenceStep[] {
  return sequence.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

export default function StepSequence({ draft, onChange }: Props) {
  function toggleChannel(c: Channel) {
    const next = draft.channels_enabled.includes(c)
      ? draft.channels_enabled.filter((x) => x !== c)
      : [...draft.channels_enabled, c];
    onChange({ channels_enabled: next });
  }

  function addStep() {
    const lastDay = draft.sequence.at(-1)?.day ?? 0;
    onChange({
      sequence: [
        ...draft.sequence,
        { day: lastDay + 3, channel: 'email', action: 'Follow-up', note: '' },
      ],
    });
  }

  function removeStep(idx: number) {
    onChange({ sequence: draft.sequence.filter((_, i) => i !== idx) });
  }

  return (
    <div className="space-y-6">
      <div>
        <label className="label">Channels</label>
        <div className="grid grid-cols-3 gap-3">
          {CHANNEL_ORDER.map((c) => {
            const on = draft.channels_enabled.includes(c);
            const info = CHANNEL_INFO[c];
            return (
              <button
                key={c}
                type="button"
                onClick={() => toggleChannel(c)}
                className={clsx(
                  'text-left rounded-md border p-3 transition-colors',
                  on
                    ? 'border-brand bg-brand-light'
                    : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <div className="text-lg">{info.icon}</div>
                <div className="font-medium text-slate-800">{info.label}</div>
                <div className="text-[11px] text-slate-500 mt-1">{info.note}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="label">Sequence</label>
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-3 py-2 text-left w-20">Day</th>
                <th className="px-3 py-2 text-left w-32">Channel</th>
                <th className="px-3 py-2 text-left">Action</th>
                <th className="px-3 py-2 text-left">Note</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {draft.sequence.map((step, idx) => (
                <tr key={idx} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={1}
                      value={step.day}
                      onChange={(e) =>
                        onChange({
                          sequence: updateStep(draft.sequence, idx, {
                            day: Number(e.target.value) || 1,
                          }),
                        })
                      }
                      className="input py-1"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className="input py-1"
                      value={step.channel}
                      onChange={(e) =>
                        onChange({
                          sequence: updateStep(draft.sequence, idx, {
                            channel: e.target.value as Channel,
                          }),
                        })
                      }
                    >
                      {CHANNEL_ORDER.map((c) => (
                        <option key={c} value={c}>
                          {CHANNEL_INFO[c].icon} {CHANNEL_INFO[c].label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="input py-1"
                      value={step.action}
                      onChange={(e) =>
                        onChange({
                          sequence: updateStep(draft.sequence, idx, {
                            action: e.target.value,
                          }),
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      className="input py-1"
                      value={step.note ?? ''}
                      onChange={(e) =>
                        onChange({
                          sequence: updateStep(draft.sequence, idx, {
                            note: e.target.value,
                          }),
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => removeStep(idx)}
                      className="text-slate-400 hover:text-rose-600"
                      type="button"
                      aria-label="Remove step"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-slate-100 p-2">
            <button type="button" onClick={addStep} className="btn-ghost text-xs">
              + Add step
            </button>
          </div>
        </div>
      </div>

      <div>
        <label className="label">Daily send limits</label>
        <div className="grid grid-cols-3 gap-4">
          {CHANNEL_ORDER.map((c) => {
            const max = c === 'email' ? 500 : c === 'linkedin' ? 100 : 250;
            const val = draft.daily_limits[c];
            return (
              <div key={c}>
                <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                  <span>{CHANNEL_INFO[c].label}</span>
                  <span className="font-mono">{val}/day</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={max}
                  value={val}
                  onChange={(e) =>
                    onChange({
                      daily_limits: {
                        ...draft.daily_limits,
                        [c]: Number(e.target.value),
                      },
                    })
                  }
                  className="w-full"
                />
                <div className="text-[10px] text-slate-400">max {max}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <label className="label">Batch size</label>
        <input
          type="number"
          className="input max-w-xs"
          min={1}
          max={10000}
          value={draft.batch_size}
          onChange={(e) =>
            onChange({ batch_size: Math.max(1, Number(e.target.value) || 1) })
          }
        />
        <div className="text-xs text-slate-500 mt-1">
          How many prospects to fetch and enqueue on launch.
        </div>
      </div>
    </div>
  );
}
