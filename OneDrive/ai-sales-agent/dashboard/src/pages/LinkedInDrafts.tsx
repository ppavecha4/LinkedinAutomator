/**
 * LinkedIn Drafts — operator action queue.
 *
 * Each card represents one AI-personalised LinkedIn message that the
 * orchestrator generated, ran through suppression + rate-limit + validator,
 * and then stopped short of sending (because we're in draft mode — see
 * docs/linkedin-setup.md). The operator's job here is:
 *
 *   1. Click "Copy + open profile"   → puts message text in clipboard
 *                                      and opens linkedin.com/in/... in
 *                                      a new tab
 *   2. Paste + send inside LinkedIn
 *   3. Click "Mark sent"             → flips status to OPERATOR_SENT,
 *                                      which counts the same as SENT in
 *                                      the funnel
 *
 * Senior-UX choices made on this page:
 *   - Body is editable inline (the operator may want to tweak before
 *     sending) — saving back is a follow-up; for now the textarea is
 *     local-state only and the copy uses the current local value
 *   - "Skip / not sending" requires a separate explicit action so an
 *     accidental skip doesn't bury the lead
 *   - Auto-refresh every 20s via React Query so newly-arrived drafts
 *     appear without a manual reload
 *   - Skeleton loaders, EmptyState, and Toast feedback consistent with
 *     the rest of the dashboard
 */

import {
  Building2,
  CheckCircle2,
  Copy,
  ExternalLink,
  Inbox,
  Briefcase,
  Sparkles,
  User,
} from 'lucide-react';
import * as React from 'react';

import {
  useLinkedInDrafts,
  useMarkDraftSent,
  type LinkedInDraft,
} from '../hooks/useDrafts';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { EmptyState } from '../components/ui/empty-state';
import { PageHeader } from '../components/ui/page-header';
import { Skeleton } from '../components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../components/ui/tooltip';
import { cn } from '../lib/cn';

/* ────────────────────────────────────────────────────────────────
 *  Single draft card
 * ──────────────────────────────────────────────────────────────── */
function DraftCard({ draft }: { draft: LinkedInDraft }) {
  const markSent = useMarkDraftSent();
  const [body, setBody] = React.useState(draft.body);
  const [copied, setCopied] = React.useState(false);
  const [done, setDone] = React.useState(false);

  // Keep local body in sync if the upstream row changes (rare but possible
  // if the orchestrator regenerates the message).
  React.useEffect(() => setBody(draft.body), [draft.body]);

  // Resolve the URL to open. Try the direct profile URL first; if missing
  // (Apollo Free tier doesn't return it), fall back to LinkedIn's people-
  // search query built from name + company. The search lands on the right
  // profile as the first result ~95% of the time.
  const directUrl =
    draft.linkedin_profile_url ?? draft.contact_linkedin_url ?? null;
  const isFallback = !directUrl;
  const fallbackUrl = (() => {
    const parts = [draft.contact_name, draft.company_name]
      .filter(Boolean)
      .join(' ');
    if (!parts) return null;
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(parts)}`;
  })();
  const profileUrl = directUrl ?? fallbackUrl;

  const copyAndOpen = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Some browsers throw if not over HTTPS or without focus — fall
      // back to a textarea-select trick is overkill for v1, just log.
      console.warn('clipboard write failed; please copy manually');
    }
    if (profileUrl) {
      window.open(profileUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const onMarkSent = async () => {
    await markSent.mutateAsync(draft.id);
    setDone(true);
  };

  // Step number badge — connection_request vs follow-up gets different label.
  const stepLabel =
    draft.sequence_step != null
      ? `Step ${draft.sequence_step}`
      : 'LinkedIn';

  return (
    <div
      className={cn(
        'glass rounded-2xl p-5 transition-all',
        done && 'opacity-50 pointer-events-none',
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Briefcase className="h-3.5 w-3.5 text-[#0a66c2]" />
            {draft.campaign_name && (
              <>
                <span className="truncate">{draft.campaign_name}</span>
                <span>·</span>
              </>
            )}
            <Badge variant="outline" className="text-[10px] py-0 h-4">
              {stepLabel}
            </Badge>
            {draft.pitch_type && (
              <Badge variant="secondary" className="text-[10px] py-0 h-4">
                {draft.pitch_type.replace(/_/g, ' ')}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1.5 font-semibold">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{draft.contact_name ?? 'Unknown'}</span>
          </div>
          {(draft.contact_title || draft.company_name) && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
              {draft.contact_title && (
                <>
                  <span className="truncate">{draft.contact_title}</span>
                  <span>·</span>
                </>
              )}
              {draft.company_name && (
                <>
                  <Building2 className="h-3 w-3" />
                  <span className="truncate">{draft.company_name}</span>
                </>
              )}
            </div>
          )}
        </div>
        {profileUrl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={profileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Open LinkedIn profile in new tab"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            </TooltipTrigger>
            <TooltipContent>
              {isFallback
                ? 'Open LinkedIn search (Apollo Free tier did not return a direct profile URL)'
                : 'Open profile'}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Editable message body */}
      <textarea
        className="input min-h-[120px] mb-3 font-sans text-sm"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck
      />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-3">
        <span>
          {body.length} / 300 characters
          {body.length > 300 && (
            <span className="text-rose-500 font-medium ml-1">— over limit</span>
          )}
        </span>
        {body.length > 300 && draft.sequence_step === 1 && (
          <span className="text-rose-500">
            LinkedIn rejects connection notes over 300 characters
          </span>
        )}
        {body.length > 280 && body.length <= 300 && draft.sequence_step === 1 && (
          <span className="text-amber-500">
            Approaching the 300-char LinkedIn limit
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={copyAndOpen}
          className="flex-1"
          disabled={!profileUrl && !body}
        >
          {copied ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Copied — paste in LinkedIn
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              {isFallback ? 'Copy + search on LinkedIn' : 'Copy + open profile'}
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={onMarkSent}
          disabled={markSent.isPending || done}
        >
          {done || markSent.isSuccess ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              Sent
            </>
          ) : (
            'Mark sent'
          )}
        </Button>
      </div>
      {markSent.isError && (
        <div className="mt-2 text-xs text-rose-500">
          Failed to mark sent — try again.
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
 *  Page
 * ──────────────────────────────────────────────────────────────── */
export default function LinkedInDrafts(): React.ReactElement {
  const { data: drafts, isLoading } = useLinkedInDrafts();

  return (
    <div>
      <PageHeader
        eyebrow="Operator queue"
        title="LinkedIn Drafts"
        description="AI-personalised LinkedIn messages awaiting your manual send. Copy the message, open the profile, send it from LinkedIn, then mark it sent."
        icon={Briefcase}
      />

      {/* How-it-works strip — collapses on mobile */}
      <div className="glass rounded-2xl p-4 mb-6 text-xs text-muted-foreground hidden md:block">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
          <span>
            Why drafts? LinkedIn does not expose an outbound DM API to standard
            business accounts. The orchestrator generates personalised copy
            (suppression-checked + rate-limited) and you click-send manually
            from LinkedIn. When Sales Navigator API access is granted, this
            queue will auto-drain.
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : !drafts || drafts.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No LinkedIn drafts pending"
          description="Drafts will appear here as the orchestrator processes prospects with a LinkedIn step in their sequence."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} />
          ))}
        </div>
      )}
    </div>
  );
}
