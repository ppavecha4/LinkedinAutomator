/**
 * Edit page for an existing campaign — `/campaigns/:id/edit`.
 *
 * Pulls the campaign + sequence_steps via useCampaign(id), reverse-maps
 * them into a WizardDraft, then renders the same 4-step CampaignForm
 * we use for new campaigns — just in 'edit' mode so the submit calls
 * PATCH /api/campaigns/:id and the buttons read "Save changes" instead
 * of "Save as Draft" / "Launch Campaign".
 *
 * UX notes:
 *   - Skeleton while the campaign is loading (it's typically <300 ms,
 *     but slow networks shouldn't see a flash of empty form fields).
 *   - The page header includes a small note that ICP changes don't
 *     retroactively affect already-discovered prospects — this is the
 *     #1 thing operators get confused about and it's worth surfacing.
 */

import { ArrowLeft, Pencil } from 'lucide-react';
import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { AuditTimeline } from '../components/AuditTimeline';
import CampaignForm from '../components/CampaignForm';
import { campaignToDraft } from '../components/CampaignForm/types';
import { HeyreachLinkPanel } from '../components/HeyreachLinkPanel';
import { PageHeader } from '../components/ui/page-header';
import { Skeleton } from '../components/ui/skeleton';
import { useCampaign } from '../hooks/useCampaigns';

export default function CampaignEditor(): React.ReactElement {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: campaign, isLoading, error } = useCampaign(id);

  if (!id) {
    // No id in the URL — should never happen with the route shape, but
    // bounce gracefully.
    React.useEffect(() => navigate('/campaigns'), [navigate]);
    return <div />;
  }

  if (isLoading) {
    return (
      <div>
        <PageHeader
          eyebrow="Edit"
          title="Edit campaign"
          description="Loading…"
          icon={Pencil}
        />
        <div className="space-y-4">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div>
        <PageHeader
          eyebrow="Edit"
          title="Campaign not found"
          description="The campaign id in the URL doesn't match any record."
          icon={Pencil}
        />
        <Link to="/campaigns" className="btn-secondary">
          <ArrowLeft className="h-4 w-4" />
          Back to campaigns
        </Link>
      </div>
    );
  }

  // useCampaign() returns the detail wrapper {campaign, sequence_steps,
  // metrics}. Stitch the two halves into a single object that matches
  // the campaignToDraft() input shape.
  const initialDraft = campaignToDraft({
    ...campaign.campaign,
    sequence_steps: campaign.sequence_steps,
  });

  return (
    <div>
      <PageHeader
        eyebrow="Edit"
        title={campaign.campaign.name}
        description="Update sender info, ICP, sequence, or daily limits. Changes save in place — they don't relaunch the campaign or duplicate it."
        icon={Pencil}
        actions={
          <Link to="/campaigns" className="btn-secondary">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        }
      />

      {/*
        Surfacing the most-confusing edit-mode caveat right at the top so
        operators understand what an ICP change does (and doesn't) do.
      */}
      <div className="glass rounded-xl p-4 mb-6 text-xs text-muted-foreground border-l-4 border-amber-500">
        <strong className="text-foreground">Heads up:</strong> changes to
        the ICP criteria don't retroactively affect prospects already
        discovered for this campaign — they only apply to subsequent
        batches. Edit safely; we keep the existing pipeline intact.
      </div>

      {/* Heyreach link status — only the LinkedIn channel uses this. */}
      <HeyreachLinkPanel
        campaignId={id}
        heyreachId={campaign.campaign.heyreach_campaign_id ?? null}
      />

      {/* Two-column layout: form on the left, change history on the right.
          Stacks below lg so mobile gets the form first then the timeline. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div className="min-w-0">
          <CampaignForm
            mode="edit"
            editingId={id}
            initialDraft={initialDraft}
          />
        </div>
        <AuditTimeline campaignId={id} className="lg:sticky lg:top-24 lg:self-start" />
      </div>
    </div>
  );
}
