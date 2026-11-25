/**
 * Get ready to send: the few things to do before the first campaign, one button each.
 * Everything is worked out from what the app already knows (hooks/useSetup.ts); each button opens
 * the screen where that one thing is done. Nothing here is technical on purpose.
 */

import { CheckCircle2, Circle, Clock, ListChecks, Lock, Rocket } from 'lucide-react';
import * as React from 'react';
import { Link } from 'react-router-dom';

import { PageHeader } from '../components/ui/page-header';
import { Progress } from '../components/ui/progress';
import { Skeleton } from '../components/ui/skeleton';
import { FirstCampaignCard } from '../components/setup/FirstCampaignCard';
import { nextStep, type SetupStep, type StepState, useSetup } from '../hooks/useSetup';
import { cn } from '../lib/cn';

const LINK = 'font-medium text-primary underline';

/** Plain-words help for the two steps that need something from outside this app. */
const HELP: Partial<Record<SetupStep['id'], { summary: string; steps: React.ReactNode[] }>> = {
  email: {
    summary: 'How do I get an app password?',
    steps: [
      'Turn on 2-Step Verification for the Google account that will send (Google Account › Security).',
      <>Open <a className={LINK} href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer">myaccount.google.com/apppasswords</a>, create an app password and copy the 16 characters.</>,
      'Choose “Connect email” and paste your email address and that app password. If you use another email provider, pick “Other mail server” there.',
      'If Google says app passwords are not available, your Workspace admin has turned them off: ask them to allow it, or use another mailbox.',
    ],
  },
  whatsapp: {
    summary: 'Where do I find these?',
    steps: [
      <>Create a free account at Twilio, or sign in at <a className={LINK} href="https://console.twilio.com" target="_blank" rel="noopener noreferrer">console.twilio.com</a>.</>,
      'On the Console home page, copy your Account SID and your Auth Token.',
      'Add a WhatsApp sender under Messaging in the Console (search “WhatsApp sender” if the menu looks different) and follow Twilio’s steps to register your business number.',
      'Choose “Connect WhatsApp” and paste the SID, the token and your WhatsApp number. We check it straight away.',
    ],
  },
};

const ICON: Record<StepState, React.ReactElement> = {
  done: <CheckCircle2 className="h-6 w-6 text-emerald-600" aria-hidden="true" />,
  todo: <Circle className="h-6 w-6 text-primary" aria-hidden="true" />,
  waiting: <Clock className="h-6 w-6 text-amber-600" aria-hidden="true" />,
  blocked: <Lock className="h-6 w-6 text-muted-foreground" aria-hidden="true" />,
};

const STATE_LABEL: Record<StepState, string> = { done: 'Done', todo: 'To do', waiting: 'Waiting for WhatsApp', blocked: 'Next' };

export default function GetReady(): React.ReactElement {
  const setup = useSetup();
  const nextId = nextStep(setup.steps)?.id;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Getting started"
        title="Get ready to send"
        description="A few steps, one button each. We do the rest: the AI writes your messages and gets WhatsApp to approve them."
        icon={ListChecks}
      />

      {setup.loading ? (
        <div className="space-y-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : !setup.applicable ? (
        <p className="glass rounded-2xl p-5 text-sm text-muted-foreground">This is the operator workspace: it runs on the keys in the server's environment file, so there is nothing to set up here.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <ol className="space-y-4">
            {setup.steps.map((s, i) => (
              <StepCard key={s.id} step={s} index={i + 1} primary={s.id === nextId} />
            ))}
          </ol>
          <aside className="space-y-5">
            <section className="glass rounded-2xl p-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-base font-semibold">Progress</h2>
                <span className="text-sm tabular-nums text-muted-foreground">{setup.done} of {setup.total}</span>
              </div>
              <Progress value={setup.total ? (setup.done / setup.total) * 100 : 0} className="mt-3" aria-label={`${setup.done} of ${setup.total} steps done`} />
              {setup.complete ? (
                <>
                  <p className="mt-3 text-sm">You are ready. Create your first campaign.</p>
                  <Link to="/campaigns/new" className="btn-primary mt-3 w-full justify-center"><Rocket className="h-4 w-4" aria-hidden="true" /> Create a campaign</Link>
                </>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">Nothing is ever sent until you launch a campaign. You can save one as a draft any time.</p>
              )}
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

function StepCard({ step, index, primary }: { step: SetupStep; index: number; primary: boolean }): React.ReactElement {
  const help = HELP[step.id];
  const active = step.state === 'todo';
  return (
    <li className={cn('glass rounded-2xl p-5', primary && 'ring-2 ring-primary/50', step.state === 'blocked' && 'opacity-70')}>
      <div className="flex items-start gap-4">
        <span className="mt-0.5 shrink-0">{ICON[step.state]}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h2 className="text-base font-bold">{index}. {step.title}</h2>
            <span className={cn('text-xs font-semibold', step.state === 'done' ? 'text-emerald-600' : step.state === 'waiting' ? 'text-amber-600' : 'text-muted-foreground')}>
              {step.optional && step.state !== 'done' ? 'Optional' : STATE_LABEL[step.state]}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{step.detail}</p>
          {step.action && (
            <Link to={step.action.to} className={cn('mt-3 inline-flex', primary || (active && !step.optional) ? 'btn-primary' : 'btn-secondary')}>
              {step.action.label}
            </Link>
          )}
          {step.id === 'first-campaign' && active && <FirstCampaignCard />}
          {help && active && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer font-medium text-primary">{help.summary}</summary>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted-foreground">
                {help.steps.map((h, i) => <li key={i}>{h}</li>)}
              </ol>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}
