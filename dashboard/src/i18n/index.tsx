/**
 * The app's screen languages.
 *
 * The English sentence is the key: `t('Sign in')`. Each other language has a file in ./locales that maps
 * those sentences to its own; a sentence missing there shows in English. `npm run i18n:check` fails when
 * a language lacks one.
 *
 * The language file is loaded BEFORE the app's modules (see main.tsx), so `t()` also works in constants
 * at the top of a file. Changing the language reloads the page.
 */

import * as React from 'react';

export const LANGUAGES_UI = [
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'es', name: 'Español', locale: 'es' },
  { code: 'pt', name: 'Português', locale: 'pt-PT' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'nl', name: 'Nederlands', locale: 'nl-NL' },
  // Western digits: what Gulf business software shows.
  { code: 'ar', name: 'العربية', locale: 'ar-u-nu-latn' },
] as const;

export type Lang = (typeof LANGUAGES_UI)[number]['code'];
export type Plural = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Dictionary = Record<string, string | Plural>;
export type Vars = Record<string, string | number | null | undefined>;

const STORAGE_KEY = 'amireach.lang';
const loaders: Record<Exclude<Lang, 'en'>, () => Promise<{ default: unknown }>> = {
  es: () => import('./locales/es.json'),
  pt: () => import('./locales/pt.json'),
  de: () => import('./locales/de.json'),
  nl: () => import('./locales/nl.json'),
  ar: () => import('./locales/ar.json'),
};

let current: Lang = 'en';
let dictionary: Dictionary = {};
let serverPatterns: { re: RegExp; names: string[]; key: string }[] | null = null;

export const lang = (): Lang => current;
/** For Intl: dates, numbers, money and names of countries and languages. */
export const locale = (): string => LANGUAGES_UI.find((l) => l.code === current)!.locale;
export const direction = (): 'ltr' | 'rtl' => (current === 'ar' ? 'rtl' : 'ltr');

function supported(tag: string | null | undefined): Lang | null {
  const primary = (tag ?? '').toLowerCase().split(/[-_]/)[0];
  return LANGUAGES_UI.find((l) => l.code === primary)?.code ?? null;
}

/** ?lang= in the address (the website sends it), else the saved choice, else the browser's languages. */
export function preferredLanguage(search: string, saved: string | null, browser: readonly string[]): Lang {
  return supported(new URLSearchParams(search).get('lang')) ?? supported(saved) ?? browser.map(supported).find(Boolean) ?? 'en';
}

function stored(): string | null {
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function store(code: Lang): void {
  try { window.localStorage.setItem(STORAGE_KEY, code); } catch { /* private window: the address or browser decides */ }
}

export function setDictionary(code: Lang, entries: Dictionary): void {
  current = code;
  dictionary = entries;
  serverPatterns = null;
}

export async function initI18n(): Promise<void> {
  const code = preferredLanguage(window.location.search, stored(), navigator.languages ?? [navigator.language]);
  if (new URLSearchParams(window.location.search).has('lang')) store(code);
  let entries: Dictionary = {};
  if (code !== 'en') {
    try { entries = (await loaders[code]()).default as Dictionary; } catch (err) { console.warn('could not load the language file', err); }
  }
  setDictionary(code, entries);
  document.documentElement.lang = code;
  document.documentElement.dir = direction();
}

export function setLanguage(code: Lang): void {
  store(code);
  const url = new URL(window.location.href);
  url.searchParams.delete('lang');
  window.location.replace(url.toString());
}

const fill = (text: string, vars?: Vars): string =>
  vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name] ?? '') : whole)) : text;

function lookup(key: string): string {
  const found = dictionary[key];
  return typeof found === 'string' && found ? found : key;
}

/** The sentence in the current language, with {name} placeholders filled in. */
export function t(key: string, vars?: Vars): string {
  return fill(lookup(key), vars);
}

/**
 * Marks a sentence that is translated where it is shown, with t(value): for values that stay English in
 * the data (sent to the server, compared in code).
 */
export const msg = (key: string): string => key;

/** A sentence that changes with a number: tn(n, '{count} lead', '{count} leads'). */
export function tn(count: number, one: string, other: string, vars?: Vars): string {
  const forms = dictionary[other];
  let text: string;
  if (forms && typeof forms === 'object') {
    text = forms[new Intl.PluralRules(locale()).select(count)] ?? forms.other ?? other;
  } else {
    text = count === 1 ? one : other;
  }
  return fill(text, { count: new Intl.NumberFormat(locale()).format(count), ...vars });
}

/**
 * A sentence with links or emphasis inside it, translated as one:
 * rich('I accept the <terms>Terms</terms>.', { terms: (words) => <Link to="/terms">{words}</Link> }).
 * {name} placeholders may be given text or elements.
 */
export function rich(
  key: string,
  parts: Record<string, React.ReactNode | ((words: React.ReactNode) => React.ReactNode)>,
): React.ReactNode {
  const render = (text: string, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    const token = /<(\w+)>(.*?)<\/\1>|\{(\w+)\}/gs;
    let last = 0;
    for (let m = token.exec(text); m; m = token.exec(text)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const k = `${depth}-${m.index}`;
      if (m[1]) {
        const wrap = parts[m[1]];
        const inner = render(m[2], depth + 1);
        out.push(<React.Fragment key={k}>{typeof wrap === 'function' ? wrap(inner) : inner}</React.Fragment>);
      } else {
        const value = parts[m[3]];
        out.push(<React.Fragment key={k}>{value === undefined || typeof value === 'function' ? m[0] : value}</React.Fragment>);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };
  return <>{render(lookup(key), 0)}</>;
}

/**
 * A message written by the server (always in English). Known sentences are translated, including ones
 * with values in them ("connect your {name} account first"); anything else is shown as it came.
 */
export function tServer(message: string): string {
  if (current === 'en' || !message) return message;
  if (typeof dictionary[message] === 'string') return lookup(message);
  serverPatterns ??= Object.keys(dictionary)
    .filter((key) => /\{\w+\}/.test(key) && typeof dictionary[key] === 'string' && key.replace(/\{\w+\}/g, '').trim().length > 8)
    // The most specific sentence first.
    .sort((a, b) => b.replace(/\{\w+\}/g, '').length - a.replace(/\{\w+\}/g, '').length)
    .map((key) => {
      const names: string[] = [];
      const source = key
        .split(/(\{\w+\})/)
        .map((piece) => {
          const m = /^\{(\w+)\}$/.exec(piece);
          if (!m) return piece.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          names.push(m[1]);
          return '(.+?)';
        })
        .join('');
      return { re: new RegExp(`^${source}$`, 's'), names, key };
    });
  for (const p of serverPatterns) {
    const m = p.re.exec(message);
    // A value may be a known phrase itself ("Meta could not {doing}: …"): translate it too.
    if (m) return t(p.key, Object.fromEntries(p.names.map((n, i) => [n, lookup(m[i + 1])])));
  }
  return message;
}

/** A country's name in the current language, from its ISO code; the code itself if unknown. */
export function regionName(iso: string): string {
  try { return new Intl.DisplayNames([locale()], { type: 'region' }).of(iso) ?? iso; } catch { return iso; }
}

/** A language's name in the current language, from its code. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([locale()], { type: 'language' }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(locale()) + name.slice(1);
  } catch { return code; }
}
