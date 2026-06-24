/**
 * HeyreachLinkPanel — surfaces the per-campaign Heyreach link state on
 * the edit page and lets the operator pick a Heyreach campaign from a
 * dropdown of their existing campaigns (or paste an ID manually).
 *
 * Why dropdown-pick instead of auto-create:
 *   Heyreach's public API doesn't reliably support creating campaigns
 *   with full sequence + account config — that work belongs in their
 *   UI. The dropdown takes you 1 click to bind an existing Heyreach
 *   campaign to a platform campaign. The "Create new in Heyreach"
 *   button deeplinks to Heyreach's campaign creator so you can build
 *   one in their UI and come back to pick it.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { useUpdateCampaign } from '../hooks/useCampaigns';
import { api } from '../lib/api';

interface HeyreachCampaign {
  id: string;
  name: string;
  status: string;
  account_count?: number;
  created_at?: string;
}

interface ListResponse {
  ok: boolean;
  campaigns: HeyreachCampaign[];
  total: number;
  error: string | null;
  skipped: boolean;
}

function useHeyreachCampaigns() {
  return useQuery({
    queryKey: ['heyreach', 'campaigns'],
    queryFn: async () => {
      const { data } = await api.get<ListResponse>('/api/heyreach/campaigns');
      return data;
    },
    // Cache briefly so refresh-button clicks feel responsive but the
    // background data stays fresh if the operator switches campaigns
    // between tabs.
    staleTime: 30_000,
  });
}

interface Props {
  campaignId: string;
  /** Current heyreach_campaign_id on the campaign row (null = not linked). */
  heyreachId: string | null | undefined;
}

export function HeyreachLinkPanel({
  campaignId,
  heyreachId,
}: Props): React.ReactElement {
  const qc = useQueryClient();
  const list = useHeyreachCampaigns();
  const update = useUpdateCampaign();
  const [manualValue, setManualValue] = React.useState(heyreachId ?? '');
  const [editing, setEditing] = React.useState(false);

  // Keep the manual-input draft in sync when the upstream value changes.
  React.useEffect(() => {
    setManualValue(heyreachId ?? '');
  }, [heyreachId]);

  const linked = !!heyreachId;

  // Find the linked campaign's name from the list so we can display it
  // (more useful than the raw id once the operator has lots of them).
  const linkedName = React.useMemo(() => {
    if (!heyreachId) return null;
    const found = list.data?.campaigns.find((c) => c.id === heyreachId);
    return found?.name ?? null;
  }, [heyreachId, list.data]);

  const onPick = async (heyreachCampaignId: string) => {
    try {
      await update.mutateAsync({
        id: campaignId,
        patch: { heyreach_campaign_id: heyreachCampaignId || null } as Partial<{
          heyreach_campaign_id: string | null;
        }>,
      });
      toast.success(
        heyreachCampaignId
          ? 'Linked to Heyreach campaign'
          : 'Heyreach link cleared',
      );
      setEditing(false);
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message });
    }
  };

  const onSaveManual = async () => onPick(manualValue.trim());

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['heyreach', 'campaigns'] });
  };

  return (
    <div className="glass rounded-xl p-4 mb-6 border-l-4 border-[#0a66c2]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#0a66c2]/15 text-[#0a66c2]">
            <Briefcase className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-semibold">
              Heyreach campaign link
              {linked && (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              )}
            </div>
            {linked ? (
              <div className="mt-1 text-xs text-muted-foreground">
                Linked to{' '}
                <strong className="text-foreground">
                  {linkedName ?? `(id ${heyreachId})`}
                </strong>
                . LinkedIn drafts on this campaign push directly to Heyreach.
              </div>
            ) : (
              <div className="mt-1 text-xs text-muted-foreground">
                Not linked. Pick an existing Heyreach campaign below or{' '}
                <a
                  href="https://app.heyreach.io/campaigns"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#0a66c2] underline"
                >
                  create one in Heyreach
                </a>
                {' '}then refresh.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Dropdown picker + actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {list.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading your Heyreach campaigns…
          </div>
        ) : list.data?.skipped ? (
          <div className="text-xs text-muted-foreground">
            Heyreach not configured on the API service (HEYREACH_API_KEY).
            You can still paste a campaign id manually below.
          </div>
        ) : list.data?.ok === false ? (
          <div className="text-xs text-rose-500">
            Heyreach API error: {list.data?.error ?? 'unknown'}{' '}
            <button
              className="ml-2 underline"
              onClick={refresh}
            >
              retry
            </button>
          </div>
        ) : (
          <>
            <div className="relative flex-1 min-w-[260px]">
              <select
                className="input h-8 text-xs pr-7 appearance-none"
                value={heyreachId ?? ''}
                onChange={(e) => onPick(e.target.value)}
                disabled={update.isPending}
              >
                <option value="">
                  {linked ? '— Unlink —' : '— Pick a Heyreach campaign —'}
                </option>
                {list.data?.campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.status !== 'UNKNOWN' ? `· ${c.status}` : ''}
                    {c.account_count !== undefined
                      ? ` · ${c.account_count} account${c.account_count === 1 ? '' : 's'}`
                      : ''}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
            </div>

            <button
              className="btn-ghost text-xs h-8 px-3"
              onClick={refresh}
              disabled={list.isFetching}
              title="Re-fetch from Heyreach"
            >
              {list.isFetching ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Refresh
            </button>

            <a
              className="btn-ghost text-xs h-8 px-3"
              href="https://app.heyreach.io/campaigns"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="h-3 w-3" />
              Create in Heyreach
            </a>
          </>
        )}
      </div>

      {/* Manual paste fallback */}
      {!editing ? (
        <button
          className="btn-ghost text-xs h-7 px-3 mt-2"
          onClick={() => setEditing(true)}
        >
          <Link2 className="h-3 w-3" />
          Or paste an id manually
        </button>
      ) : (
        <div className="mt-2 flex items-center gap-1">
          <input
            className="input h-7 text-xs flex-1"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
            placeholder="paste Heyreach campaign id"
            autoFocus
          />
          <button
            className="btn-primary text-xs h-7 px-3"
            onClick={onSaveManual}
            disabled={update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn-ghost text-xs h-7 px-3"
            onClick={() => {
              setManualValue(heyreachId ?? '');
              setEditing(false);
            }}
            disabled={update.isPending}
          >
            Cancel
          </button>
        </div>
      )}

      {list.data?.ok && list.data.campaigns.length === 0 && (
        <div className="mt-2 text-xs text-muted-foreground">
          You have no Heyreach campaigns yet.{' '}
          <a
            href="https://app.heyreach.io/campaigns"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#0a66c2] underline"
          >
            Create your first one →
          </a>
        </div>
      )}
    </div>
  );
}
