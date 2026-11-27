/**
 * Terms of Service, Privacy Policy and Data Deletion (public pages: /terms, /privacy, /data-deletion).
 *
 * The text is in ../legal/<language>.json, which the public website reads too, so the two never differ.
 * It describes what the product actually does, in plain language. It has NOT been reviewed by a lawyer
 * yet (see docs/saas-architecture.md): have it reviewed before relying on it in a dispute. English is the
 * version that applies; the others say so at the top.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';

import { LanguageSelect } from '../components/LanguageSelect';
import { lang } from '../i18n';
import ar from '../legal/ar.json';
import de from '../legal/de.json';
import en from '../legal/en.json';
import es from '../legal/es.json';
import nl from '../legal/nl.json';
import pt from '../legal/pt.json';

type Doc = 'terms' | 'privacy' | 'data-deletion';
const DOCS: Doc[] = ['terms', 'privacy', 'data-deletion'];
const TEXT: Record<string, typeof en> = { en, es, pt, de, nl, ar };

export default function Legal({ doc }: { doc: Doc }): React.ReactElement {
  const text = TEXT[lang()] ?? en;
  const page = text[doc];
  return (
    <div className="min-h-screen bg-background px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            <Link to="/login" className="underline">{text.back}</Link>
            {DOCS.filter((d) => d !== doc).map((d) => (
              <React.Fragment key={d}><span className="mx-2 text-muted-foreground">·</span><Link to={`/${d}`} className="underline">{text[d].title}</Link></React.Fragment>
            ))}
          </p>
          <LanguageSelect />
        </div>
        <h1 className="text-3xl font-semibold">{page.title}</h1>
        <p className="mt-2 text-xs text-muted-foreground">{text.updated_label}</p>
        {text.translation_note && <p className="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">{text.translation_note}</p>}
        <div className="mt-8 space-y-7">
          {page.sections.map((s, i) => (
            <section key={s.title} aria-labelledby={`l-${i}`}>
              <h2 id={`l-${i}`} className="mb-2 text-lg font-semibold">{s.title}</h2>
              {s.body.map((p) => <p key={p.slice(0, 40)} className="mb-3 text-sm leading-relaxed text-muted-foreground">{p}</p>)}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
