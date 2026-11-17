/**
 * Terms of Service and Privacy Policy (public pages, /terms and /privacy).
 *
 * DRAFTS. They describe what the product actually does, in plain language,
 * but they have not been reviewed by a lawyer and carry placeholders
 * ([LEGAL NAME], [CONTACT EMAIL], [GOVERNING LAW]) that must be filled in
 * before real customers sign up. The page says so, on purpose.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';


interface Section {
  title: string;
  body: string[];
}

const TERMS: Section[] = [
  { title: 'What this is', body: [
    'AI Sales Agent helps your company find potential customers, write personalised messages in their language, and send them from your own email and WhatsApp accounts. By creating an account or accepting an invitation you agree to these terms on behalf of yourself and your company.',
  ] },
  { title: 'Your account', body: [
    'Keep your password safe and tell us if you think someone else has your session ("Sign out everywhere" ends every session). The company owner is responsible for who is on the team and what they can do.',
  ] },
  { title: 'Your responsibilities for outreach', body: [
    'You decide who is contacted and what is said. You must have a lawful basis to contact the people on your lists (including consent where the law requires it, such as for WhatsApp in many countries), and you must follow the anti-spam, privacy and messaging rules that apply to you and to the people you contact.',
    'You must honour opt-outs. The product stops messaging anyone who opts out, in any language, but you must not try to work around that, and you must not upload people who have asked not to be contacted.',
    'You are responsible for the content that is sent in your name. Messages are drafted by AI from the facts you give us; read what it writes about your business and correct it. Do not use the product for anything unlawful, deceptive, harassing, or to send spam, scams or malware.',
  ] },
  { title: 'Your own accounts and keys', body: [
    'Messages go out from the accounts you connect (your mailbox, your Twilio account, your AI provider key, your lead-search key). You pay those providers directly and you must follow their rules; they can suspend you independently of us. Keys you give us are stored encrypted and are used only to run your campaigns. If an account stops working we pause what depends on it.',
  ] },
  { title: 'Your data', body: [
    'You own your data, including your lists and messages. We use it only to provide the service to you. See the Privacy Policy for how we handle it, including our role for the contact data you upload.',
  ] },
  { title: 'Suspension and ending', body: [
    'We may suspend an account that breaks these terms, harms other people or our systems, or generates complaints or heavy bounces; campaigns are paused while it is suspended. You can stop using the service at any time. We can end the service with notice; we will give you a way to export your data.',
  ] },
  { title: 'No guarantees, limits on liability', body: [
    'We work hard to keep the service reliable, but it is provided as is. We do not promise replies, meetings or sales, and we are not responsible for outcomes of campaigns you choose to run. To the extent the law allows, our liability is limited to the fees you paid us in the 12 months before the problem. Nothing here limits liability that cannot be limited by law.',
  ] },
  { title: 'Changes and contact', body: [
    'We may update these terms; we will tell you about material changes. Governing law: [GOVERNING LAW]. Questions: [CONTACT EMAIL].',
  ] },
];

const PRIVACY: Section[] = [
  { title: 'Who we are', body: [
    '[LEGAL NAME] ("we") runs AI Sales Agent. For your account and team (names, work emails, sign-in details) we decide how data is used. For the contact data you upload or have us find for you (people you want to reach), you decide and we process it for you, under your instructions.',
  ] },
  { title: 'What we store', body: [
    'Account data: your name, work email, a salted password hash (never the password), your company profile, and sign-in activity.',
    'Campaign data: the lists you upload, prospects and contacts found for you, the messages written and sent, replies, opt-outs and bounces, and a record of what happened.',
    'Connection secrets: API keys and app passwords you connect are encrypted before storage and never shown again.',
  ] },
  { title: 'Where contact data comes from', body: [
    'From your uploads, and, if you use AI discovery, from a lead-search provider you connect (for example Apollo) using your own key. You must have a lawful basis to contact these people, and you confirm that when you import a list.',
  ] },
  { title: 'Who else handles data (our service providers)', body: [
    'Our cloud hosting and database provider; the AI provider that writes and understands messages (Anthropic), which receives the facts about your business and the prospect needed for each message; Twilio, for WhatsApp, and your own email provider, which carry the messages you send; and, if you use it, your lead-search provider. We choose providers carefully and they act only to deliver the service. Customers\' own accounts are governed by their own agreements with those providers.',
  ] },
  { title: 'Opt-outs and suppression', body: [
    'When someone asks not to be contacted, in any language, their address and number are added to your suppression list and checked again before every send. Bounced email addresses are suppressed for email.',
  ] },
  { title: 'How long we keep it', body: [
    'While your account is active. Uploaded rows from an import you cancel are deleted at once. When you close your account we delete or anonymise your data within [RETENTION PERIOD], except what we must keep by law.',
  ] },
  { title: 'Security', body: [
    'Each company\'s data is isolated at the database level, secrets are encrypted, sessions end when you leave a team or change your password, and access by our staff is limited and logged. No system is perfectly secure; tell us at once if you suspect a problem.',
  ] },
  { title: 'Your rights and contact', body: [
    'You can access, correct, export and delete your account data, and people whose data is in a customer\'s campaign can ask that customer (or us, and we will pass it on) to access, correct or delete it, or stop contacting them. Contact: [CONTACT EMAIL]. If you are in the EU/UK/India or another region with specific rules, you may also have the right to complain to your data-protection authority.',
  ] },
];

export default function Legal({ doc }: { doc: 'terms' | 'privacy' }): React.ReactElement {
  const sections = doc === 'terms' ? TERMS : PRIVACY;
  const title = doc === 'terms' ? 'Terms of Service' : 'Privacy Policy';
  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <p className="mb-6 text-sm">
          <Link to="/login" className="underline">Back to sign in</Link>
          <span className="mx-2 text-muted-foreground">·</span>
          <Link to={doc === 'terms' ? '/privacy' : '/terms'} className="underline">{doc === 'terms' ? 'Privacy Policy' : 'Terms of Service'}</Link>
        </p>
        <h1 className="text-3xl font-semibold">{title}</h1>
        <p role="note" className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          Draft for legal review. This text describes how the product works in plain language but has not been reviewed by a lawyer, and the items in [square brackets] are still to be filled in.
        </p>
        <div className="mt-8 space-y-7">
          {sections.map((s) => (
            <section key={s.title} aria-labelledby={`l-${s.title.replace(/\W+/g, '-')}`}>
              <h2 id={`l-${s.title.replace(/\W+/g, '-')}`} className="mb-2 text-lg font-semibold">{s.title}</h2>
              {s.body.map((p) => <p key={p.slice(0, 40)} className="mb-3 text-sm leading-relaxed text-muted-foreground">{p}</p>)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

