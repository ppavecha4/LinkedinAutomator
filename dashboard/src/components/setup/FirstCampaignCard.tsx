/**
 * "Here is the campaign we would run": the AI's first campaign, assembled from what the company already
 * told us, shown in plain words with one button. Nothing is sent: the campaign is saved as a draft and the
 * owner is taken to add their people, then launches from there.
 */

import { Loader2, Rocket } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useCreateFirstCampaign, useFirstCampaign } from '../../hooks/useFirstCampaign';
import { errorMessage } from '../../lib/authContext';
import { CHANNEL_LABEL } from '../../lib/workspace';

export function FirstCampaignCard({ canCreate = true }: { canCreate?: boolean }): React.ReactElement | null {
  const navigate = useNavigate();
  const view = useFirstCampaign();
  const create = useCreateFirstCampaign();
  const proposal = view.data?.proposal;

  if (view.isLoading) return <Loader2 className="mt-3 h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />;
  if (!proposal) {
    const blockers = view.data?.blockers ?? [];
    return blockers.length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null;
  }

  const s = proposal.summary;
  const channels = s.channels.map((c) => CHANNEL_LABEL[c]).join(' and ');
  const followChannels = s.follow_ups.channels.map((c) => CHANNEL_LABEL[c]).join(' and ');
  const days = Array.from({ length: s.follow_ups.count }, (_, i) => s.follow_ups.gap_days * (i + 1)).join(' and ');

  async function go() {
    try {
      const id = await create.mutateAsync(proposal!.body);
      toast.success('Your first campaign is ready', { description: 'Nothing is sent yet: add the people you want to reach, then launch.' });
      navigate(`/campaigns/${id}/import`);
    } catch (e) {
      toast.error(errorMessage(e, 'Could not create the campaign.'));
    }
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
      <p className="text-sm font-semibold">{proposal.body.name}</p>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Offers</dt><dd>{s.offering}</dd>
        {s.audience.map((line) => {
          const [label, ...rest] = line.split(': ');
          return <React.Fragment key={line}><dt className="text-muted-foreground">{label}</dt><dd>{rest.join(': ')}</dd></React.Fragment>;
        })}
        <dt className="text-muted-foreground">Reaches them by</dt><dd>{channels}</dd>
        <dt className="text-muted-foreground">If no reply</dt><dd>{s.follow_ups.count} follow-ups on {followChannels}, after {days} days</dd>
        <dt className="text-muted-foreground">Writes in</dt><dd>{s.languages}</dd>
        <dt className="text-muted-foreground">Goal</dt><dd>{s.goal}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">Nothing is sent until you add your people and launch. You can change any of this first.</p>
      <div className="flex flex-wrap gap-2">
        {canCreate && (
          <button type="button" className="btn-primary" onClick={go} disabled={create.isPending}>
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
            Create it and add my people
          </button>
        )}
        <Link to="/campaigns/new" className="btn-ghost text-xs">Set it up myself instead</Link>
      </div>
    </div>
  );
}
