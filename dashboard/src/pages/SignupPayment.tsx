/**
 * /signup/payment — the one-time sign-up fee, between creating the account and
 * setting it up. Paying happens on the provider's own page; back here we ask
 * the API to check with the provider (nothing the browser says counts).
 */

import { Loader2 } from 'lucide-react';
import * as React from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';

import { rich, t } from '../i18n';
import { AuthShell, FormError } from '../components/auth/AuthShell';
import { api } from '../lib/api';
import { errorMessage, useAuth, type SignupFeeOffer } from '../lib/authContext';
import { cn } from '../lib/cn';
import { formatFee, looksLikeIndia } from '../lib/money';

const CHECKS = 20;          // after returning from the provider: about a minute
const CHECK_EVERY_MS = 3000;

const LABEL: Record<SignupFeeOffer['id'], { title: string; how: string }> = {
  india: { title: t('India'), how: t('BHIM UPI and other UPI apps, cards, netbanking') },
  international: { title: t('Outside India'), how: t('Debit or credit card') },
};

export default function SignupPaymentPage(): React.ReactElement {
  const { user, org, bypassMode, needsPayment, needsOnboarding, logout, refresh } = useAuth();
  const [params] = useSearchParams();
  const returned = params.get('from') === 'provider';
  const [offers, setOffers] = React.useState<SignupFeeOffer[] | null>(null);
  const [paying, setPaying] = React.useState<SignupFeeOffer['id'] | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [notYet, setNotYet] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const check = React.useCallback(async (): Promise<boolean> => {
    const { data } = await api.post<{ due: boolean }>('/api/signup-payment/confirm');
    if (data.due) return false;
    await refresh();                       // the account is open: the redirect below takes over
    return true;
  }, [refresh]);

  React.useEffect(() => {
    if (!needsPayment) return;
    api.get<{ offers: SignupFeeOffer[] }>('/api/signup-payment')
      .then(({ data }) => setOffers([...data.offers].sort((a) => ((a.id === 'india') === looksLikeIndia() ? -1 : 1))))
      .catch((e) => setError(errorMessage(e, t('Could not load the ways to pay.'))));
  }, [needsPayment]);

  // Back from the provider: the confirmation can take a few seconds to arrive.
  React.useEffect(() => {
    if (!returned || !needsPayment) return;
    let stopped = false;
    let timer = 0;
    let tries = 0;
    setChecking(true);
    async function again() {
      tries += 1;
      const paid = await check().catch(() => false);
      if (stopped || paid) return;
      if (tries >= CHECKS) {
        setChecking(false);
        setNotYet(true);
        return;
      }
      timer = window.setTimeout(again, CHECK_EVERY_MS);
    }
    again();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [returned, needsPayment, check]);

  if (!user || bypassMode) return <Navigate to="/login" replace />;
  if (!needsPayment) return <Navigate to={needsOnboarding ? '/onboarding' : '/'} replace />;

  async function pay(offer: SignupFeeOffer['id']) {
    setPaying(offer);
    setError(null);
    try {
      const { data } = await api.post<{ url: string }>('/api/signup-payment/start', { offer });
      window.location.assign(data.url);
    } catch (e) {
      setError(errorMessage(e, t('Could not open the payment page. Try again.')));
      setPaying(null);
    }
  }

  async function checkNow() {
    setChecking(true);
    setNotYet(false);
    setError(null);
    try {
      if (!(await check())) setNotYet(true);
    } catch (e) {
      setError(errorMessage(e, t('Could not check your payment.')));
    } finally {
      setChecking(false);
    }
  }

  const owner = !user.role || user.role === 'owner';

  return (
    <AuthShell
      backToSignIn={false}
      title={t('One last step: the sign-up fee')}
      intro={<>{org?.name
        ? rich('A single payment opens {name}. It is not a subscription.', { name: <strong>{org.name}</strong> })
        : t('A single payment opens your account. It is not a subscription.')}</>}
    >
      <div className="space-y-3">
        {params.get('cancelled') && <p className="text-sm text-muted-foreground">{t('Payment cancelled. Nothing was charged.')}</p>}
        {checking && (
          <p role="status" className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{' '}{t('Checking your payment…')}
          </p>
        )}
        {notYet && (
          <p role="status" className="rounded-lg border border-border p-3 text-sm">
            {t('We haven\'t received a payment yet. If money left your account, wait a minute and check again; do not pay twice.')}
          </p>
        )}
        {!owner && <p className="text-sm">{t('Ask your company\'s owner to pay the sign-up fee.')}</p>}
        {owner && offers === null && !error && <Loader2 className="mx-auto h-5 w-5 animate-spin" aria-label={t('Loading')} />}
        {owner && offers?.length === 0 && (
          <p className="text-sm">{t('Online payment is not available right now. Write to info@appsontechnologies.in.')}</p>
        )}
        {owner && offers?.map((o, i) => (
          <button key={o.id} type="button" disabled={paying !== null} onClick={() => pay(o.id)}
            className={cn('flex w-full items-center justify-between gap-3 rounded-xl border p-4 text-start transition-colors hover:bg-accent/40 disabled:opacity-60',
              i === 0 ? 'border-primary' : 'border-border')}>
            <span>
              <span className="block text-sm font-semibold">{LABEL[o.id].title}</span>
              <span className="block text-xs text-muted-foreground">{LABEL[o.id].how}</span>
              {o.tax_minor > 0 && <span className="block text-xs text-muted-foreground">{t('Includes GST {tax_minor}', { tax_minor: formatFee(o.tax_minor, o.currency) })}</span>}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap font-semibold">
              {paying === o.id && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('Pay {amount_minor}', { amount_minor: formatFee(o.amount_minor, o.currency) })}
            </span>
          </button>
        ))}
        <FormError text={error} />
        <button type="button" className="btn-secondary w-full justify-center" onClick={checkNow} disabled={checking}>
          {t('I\'ve paid: check again')}
        </button>
        <p className="text-xs text-muted-foreground">
          {rich('You pay on the payment provider\'s secure page; we never see your card or UPI details. Refunds are explained in the <terms>Terms of Service</terms>.', {
            terms: (words) => <Link to="/terms" target="_blank" className="underline">{words}</Link>,
          })}
        </p>
        <p className="text-center text-xs">
          <button type="button" className="underline" onClick={() => logout()}>{t('Sign out')}</button>
        </p>
      </div>
    </AuthShell>
  );
}
