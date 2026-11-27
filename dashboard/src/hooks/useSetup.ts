/**
 * "Get ready to send": the few things a company has to do before its first campaign, worked out
 * from data the app already has (profile, connected accounts, AI included in the plan, WhatsApp
 * templates). No new server code: the page only reads and points at the right screen.
 *
 * States: done · todo (do this) · waiting (nothing to do, someone else is working: WhatsApp) ·
 * blocked (needs an earlier step first).
 */

import { t } from '../i18n';
import { useBilling } from './useBilling';
import { useFirstCampaign } from './useFirstCampaign';
import { useMetaSignupConfig } from './useMetaSignup';
import { useProfile } from './useProfile';
import { useCredentials, useOrganization } from './useWorkspace';
import { useWhatsAppTemplates } from './useWhatsAppTemplates';
import { verifiedFor, connectedFor } from '../lib/workspace';

export type StepState = 'done' | 'todo' | 'waiting' | 'blocked';

export interface SetupStep {
  id: 'business' | 'ai' | 'email' | 'whatsapp' | 'whatsapp-messages' | 'first-campaign' | 'launch';
  title: string;
  /** One plain sentence on where this stands. */
  detail: string;
  state: StepState;
  /** The one thing to do next (a screen to open). */
  action?: { label: string; to: string };
  /** Not needed: another channel is already ready, so this one can wait. */
  optional?: boolean;
}

/** The step to put in front of the person: the first thing to do that is actually needed. */
export function nextStep(steps: SetupStep[]): SetupStep | undefined {
  return steps.find((s) => s.state === 'todo' && !s.optional) ?? steps.find((s) => s.state === 'todo') ?? steps.find((s) => s.state === 'waiting' && !s.optional);
}

export interface Setup {
  loading: boolean;
  steps: SetupStep[];
  done: number;
  total: number;
  /** Everything needed is in place: the first campaign can go. */
  complete: boolean;
  /** The operator (Appson) workspace runs on server settings: nothing to set up here. */
  applicable: boolean;
}

const EMAIL_PROVIDERS = ['google_workspace', 'smtp', 'ses'];

export function useSetup(): Setup {
  const org = useOrganization();
  const creds = useCredentials();
  const profile = useProfile();
  const billing = useBilling();
  const wantsWhatsApp = !!org.data?.channels.includes('whatsapp');
  const templates = useWhatsAppTemplates(wantsWhatsApp && !org.data?.operator);
  const first = useFirstCampaign(!org.data?.operator);
  const metaSignup = useMetaSignupConfig();

  const loading = org.isLoading || creds.isLoading || profile.isLoading || billing.isLoading || (wantsWhatsApp && templates.isLoading);
  if (loading || !org.data) return { loading: true, steps: [], done: 0, total: 0, complete: false, applicable: true };
  if (org.data.operator) return { loading: false, steps: [], done: 0, total: 0, complete: true, applicable: false };

  const steps: SetupStep[] = [];

  // 1. The business: the AI can only say what it was told.
  const onboarded = !!profile.data?.onboarding.completed_at;
  steps.push({
    id: 'business',
    title: t('Tell us about your business'),
    detail: onboarded ? t('The AI knows what you sell and who to look for.') : t('Five short steps. The AI reads your website and fills most of it in.'),
    state: onboarded ? 'done' : 'todo',
    action: onboarded ? { label: t('Review'), to: '/settings/profile' } : { label: t('Start'), to: '/onboarding' },
  });

  // 2. The AI that writes the messages: included in the plan, unless it is used up or the platform has none.
  const ai = billing.data?.ai;
  const ownAi = !!verifiedFor(creds.data, ['anthropic']);
  const includedAi = !!ai?.managed && !ai.exhausted;
  steps.push(
    ownAi || includedAi
      ? { id: 'ai', title: t('The AI that writes your messages'), detail: ownAi ? t('Using your own AI account.') : t('Included in your plan: nothing to connect.'), state: 'done' }
      : ai?.managed && ai.exhausted
        ? { id: 'ai', title: t('The AI that writes your messages'), detail: t('The AI included in your plan is used up this month. Upgrade, or connect your own AI account.'), state: 'todo', action: { label: t('See plans'), to: '/settings/plan' } }
        : { id: 'ai', title: t('The AI that writes your messages'), detail: t('Connect your own AI account so it can write for you.'), state: 'todo', action: { label: t('Connect'), to: '/settings/connections?connect=anthropic' } },
  );

  // 3. Email.
  if (org.data.channels.includes('email')) {
    const ok = !!verifiedFor(creds.data, EMAIL_PROVIDERS);
    const broken = connectedFor(creds.data, EMAIL_PROVIDERS);
    steps.push({
      id: 'email',
      title: t('Send email from your own address'),
      detail: ok ? t('Your email address is connected and checked.')
        : broken?.status === 'FAILED' && broken.last_error ? t('It did not work: {last_error}', { last_error: broken.last_error })
        : t('Connect the mailbox your messages go out from, so replies come back to you.'),
      state: ok ? 'done' : 'todo',
      action: ok ? undefined : { label: broken ? t('Fix it') : t('Connect email'), to: '/settings/connections?connect=google_workspace' },
    });
  }

  // 4 + 5. WhatsApp: the account, then the messages WhatsApp has to approve.
  if (wantsWhatsApp) {
    // Connected either one-click through Meta (slice 10.2) or through the company's own Twilio account.
    const twilioOk = !!verifiedFor(creds.data, ['twilio', 'whatsapp_meta']);
    const oneClick = !!metaSignup.data?.enabled;
    const twilioBroken = connectedFor(creds.data, ['twilio']);
    steps.push({
      id: 'whatsapp',
      title: t('Connect WhatsApp'),
      detail: twilioOk ? t('Your WhatsApp account is connected and checked.')
        : twilioBroken?.status === 'FAILED' && twilioBroken.last_error ? t('It did not work: {last_error}', { last_error: twilioBroken.last_error })
        : oneClick ? t('Sign in with Facebook and pick your WhatsApp number. It takes a couple of minutes: nothing to copy or paste.')
        : t('WhatsApp goes through your Twilio account. It takes about ten minutes the first time.'),
      state: twilioOk ? 'done' : 'todo',
      action: twilioOk ? undefined : { label: twilioBroken ? t('Fix it') : t('Connect WhatsApp'), to: oneClick && !twilioBroken ? '/settings/connections#whatsapp-connect' : '/settings/connections?connect=twilio' },
    });

    const rows = templates.data?.templates ?? [];
    const ready = (templates.data?.languages ?? []).some((l) => l.ready);
    const pending = rows.some((item) => item.status === 'PENDING');
    const drafts = rows.some((item) => item.status === 'DRAFT' || item.status === 'REJECTED');
    steps.push({
      id: 'whatsapp-messages',
      title: t('Get your WhatsApp messages approved'),
      detail: ready ? t('Approved by WhatsApp: ready to send.')
        : !twilioOk ? t('We write these for you once WhatsApp is connected.')
        : pending ? t('Sent to WhatsApp for approval. This takes from a few minutes to a day: we start using them as soon as they are approved.')
        : drafts ? t('Your messages are written. Read them, then send them for approval.')
        : t('WhatsApp must approve your first messages. We write them for you and send them in.'),
      state: ready ? 'done' : !twilioOk ? 'blocked' : pending ? 'waiting' : 'todo',
      action: ready || !twilioOk || pending ? undefined : { label: drafts ? t('Review and send') : t('Write my messages'), to: '/settings/connections#wa-messages-title' },
    });
  }

  // Needed: the business, the AI, and ONE way to send. The other channel is a bonus, so it never holds anyone back.
  const state = (id: SetupStep['id']) => steps.find((s) => s.id === id)?.state;
  const channelReady = state('email') === 'done' || state('whatsapp-messages') === 'done';
  const ready = onboarded && state('ai') === 'done' && channelReady;
  if (channelReady) for (const s of steps) if ((s.id === 'email' || s.id === 'whatsapp' || s.id === 'whatsapp-messages') && s.state !== 'done') s.optional = true;

  // 6. The first campaign, proposed by the AI from what the company already told us.
  const view = first.data;
  const hasCampaign = (view?.existing_campaigns ?? 0) > 0;
  steps.push({
    id: 'first-campaign',
    title: t('Create your first campaign'),
    detail: hasCampaign ? t('You have a campaign.')
      : !ready ? t('The AI proposes it for you as soon as the steps above are done: you only press a button.')
      : view?.proposal ? t('The AI has a campaign ready for you to look over.')
      : (view?.blockers[0] ?? t('Almost there.')),
    state: hasCampaign ? 'done' : ready && view?.proposal ? 'todo' : 'blocked',
    action: hasCampaign ? { label: t('View campaigns'), to: '/campaigns' } : undefined,
  });

  // 7. People and launch: the draft needs people before anything can be sent.
  const latest = view?.latest ?? null;
  steps.push({
    id: 'launch',
    title: t('Add your people and launch'),
    detail: !latest ? t('Once your campaign is created, you add the people to reach and launch it.')
      : latest.status === 'DRAFT' ? t('Add the people you want to reach, then launch.')
      : t('Your campaign is running.'),
    state: !latest ? 'blocked' : latest.status === 'DRAFT' ? 'todo' : 'done',
    action: latest && latest.status === 'DRAFT' ? { label: t('Add my people'), to: `/campaigns/${latest.id}/import` } : undefined,
  });

  // "waiting" counts as not done yet but is nothing the person can speed up.
  const done = steps.filter((s) => s.state === 'done').length;
  return { loading: false, steps, done, total: steps.length, complete: ready && state('launch') === 'done', applicable: true };
}
