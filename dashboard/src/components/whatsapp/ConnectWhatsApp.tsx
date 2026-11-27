/**
 * Settings › Connected accounts › Connect WhatsApp (slice 10.2).
 *
 * One button. It opens Meta's own sign-up window (Embedded Signup): the owner picks or creates their
 * WhatsApp Business account and verifies their number there. Meta then hands this page a one-time code
 * and the account and number ids; the server finishes the connection (see routes/whatsappMeta.ts).
 * No tokens to copy, no other account to open.
 *
 * Meta's script is loaded only when the button is pressed, never on page load. The whole card is hidden
 * until the server has the Meta app settings.
 */

import { CheckCircle2, Loader2, MessageCircle, Trash2 } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { t } from '../../i18n';
import { type MetaSignupConfig, useConnectMeta, useMetaSignupConfig } from '../../hooks/useMetaSignup';
import { useCredentials, useRemoveCredential } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/authContext';
import { verifiedFor } from '../../lib/workspace';

interface FacebookSdk {
  init(o: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
  login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void;
}
declare global {
  interface Window { FB?: FacebookSdk; fbAsyncInit?: () => void }
}

const META_ORIGINS = ['https://www.facebook.com', 'https://web.facebook.com'];

function loadFacebookSdk(cfg: MetaSignupConfig): Promise<FacebookSdk> {
  return new Promise((resolve, reject) => {
    const init = () => {
      if (!window.FB) return reject(new Error(t('Meta did not load')));
      window.FB.init({ appId: cfg.app_id ?? '', autoLogAppEvents: false, xfbml: false, version: cfg.graph_version ?? 'v23.0' });
      resolve(window.FB);
    };
    if (window.FB) return init();
    window.fbAsyncInit = init;
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.onerror = () => reject(new Error(t('Could not load Meta\'s sign-up. An ad blocker may be stopping it.')));
    document.body.appendChild(s);
  });
}

interface SignupIds { waba_id?: string; phone_number_id?: string }

export function ConnectWhatsApp({ canManage }: { canManage: boolean }): React.ReactElement | null {
  const cfg = useMetaSignupConfig();
  const creds = useCredentials();
  const connect = useConnectMeta();
  const remove = useRemoveCredential();
  const [busy, setBusy] = React.useState<'idle' | 'opening' | 'finishing'>('idle');
  const [problem, setProblem] = React.useState('');
  // Meta reports the code (login callback) and the ids (a window message) separately, in either order.
  const code = React.useRef<string | undefined>(undefined);
  const ids = React.useRef<SignupIds>({});
  const finished = React.useRef(false);

  const finish = React.useCallback(() => {
    if (finished.current || !code.current || !ids.current.waba_id) return;
    finished.current = true;
    setBusy('finishing');
    connect.mutate(
      { code: code.current, waba_id: ids.current.waba_id, ...(ids.current.phone_number_id ? { phone_number_id: ids.current.phone_number_id } : {}) },
      {
        onSuccess: (c) => { setProblem(''); toast.success(t('WhatsApp connected: {number}', { number: String((c.meta as Record<string, unknown>)?.display_phone_number ?? t('your number')) })); },
        onError: (e) => setProblem(errorMessage(e, t('Could not finish connecting WhatsApp.'))),
        onSettled: () => setBusy('idle'),
      },
    );
  }, [connect]);

  React.useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (!META_ORIGINS.includes(ev.origin)) return;
      let msg: { type?: string; event?: string; data?: SignupIds & { current_step?: string; error_message?: string } };
      try { msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch { return; }
      if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (msg.event === 'FINISH' || msg.event === 'FINISH_ONLY_WABA') {
        ids.current = { waba_id: msg.data?.waba_id, phone_number_id: msg.data?.phone_number_id };
        finish();
      } else if (msg.event === 'CANCEL') {
        setBusy('idle');
        setProblem(t('Sign-up was closed before it finished. Press Connect WhatsApp to continue where you left off.'));
      } else if (msg.data?.error_message) {
        setBusy('idle');
        setProblem(t('Meta says: {error_message}', { error_message: msg.data.error_message }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [finish]);

  if (!cfg.data?.enabled) return null;
  const mine = verifiedFor(creds.data, ['whatsapp_meta']);
  const metaOf = (mine?.meta ?? {}) as Record<string, unknown>;

  const start = async () => {
    setProblem('');
    code.current = undefined;
    ids.current = {};
    finished.current = false;
    setBusy('opening');
    try {
      const fb = await loadFacebookSdk(cfg.data!);
      fb.login(
        (r) => {
          if (!r.authResponse?.code) { setBusy('idle'); return; }          // closed the window: Meta's message explains
          code.current = r.authResponse.code;
          finish();
        },
        {
          config_id: cfg.data!.config_id,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {}, sessionInfoVersion: '3' },
        },
      );
    } catch (e) {
      setBusy('idle');
      setProblem(errorMessage(e, t('Could not open Meta\'s sign-up.')));
    }
  };

  return (
    <section id="whatsapp-connect" aria-labelledby="whatsapp-connect-title" className="glass rounded-2xl p-5">
      <div className="flex items-start gap-3">
        <MessageCircle className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="whatsapp-connect-title" className="text-base font-semibold">{t('Connect WhatsApp')}</h2>
          {mine ? (
            <>
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                {t('Connected: {number}', { number: String(metaOf.display_phone_number ?? t('your number')) })}{metaOf.verified_name ? ` (${String(metaOf.verified_name)})` : ''}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('Your messages go out from this number, straight through WhatsApp.')}</p>
              {canManage && (
                <button
                  type="button"
                  className="btn-secondary mt-3 inline-flex items-center gap-1.5 text-sm"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (!window.confirm(t('Disconnect this WhatsApp number? Campaigns that use WhatsApp will stop sending until you connect again.'))) return;
                    remove.mutate(mine.id, { onError: (e) => toast.error(errorMessage(e, t('Could not disconnect.'))) });
                  }}
                >
                  {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Trash2 className="h-4 w-4" aria-hidden="true" />}
                  {t('Disconnect')}
                </button>
              )}
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('Sign in with Facebook, pick (or create) your WhatsApp Business account and verify your number. It takes a couple of minutes and there is nothing to copy or paste. Messages go out from your own number.')}
              </p>
              {canManage ? (
                <button type="button" className="btn-primary mt-3 inline-flex items-center gap-2" onClick={start} disabled={busy !== 'idle'}>
                  {busy !== 'idle' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {busy === 'finishing' ? t('Connecting your number…') : busy === 'opening' ? t('Opening Meta…') : t('Connect WhatsApp')}
                </button>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">{t('Ask an owner or admin to connect WhatsApp.')}</p>
              )}
              <p className="mt-3 text-xs text-muted-foreground">{t('Already use Twilio for WhatsApp? Keep using it with the card below instead.')}</p>
            </>
          )}
          {problem && <p role="alert" className="mt-3 text-sm text-destructive">{problem}</p>}
        </div>
      </div>
    </section>
  );
}
