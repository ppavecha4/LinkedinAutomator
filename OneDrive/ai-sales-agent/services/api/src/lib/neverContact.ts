/**
 * The business profile's "never contact" list and blocked countries, as
 * the lead import applies them (SaaS slice 3.2).
 *
 * Matching is the same as the orchestrator's
 * services/orchestrator/src/agents/profile_rules.py — keep the two in step
 * (they share the test cases in tests/neverContact.test.ts and
 * tests/test_profile_rules.py):
 *   - "jane@acme.com"  an exact email address;
 *   - "acme.com"       a domain: acme.com and any subdomain, by email
 *                      domain or company website ("@acme.com" too);
 *   - "Grupo Andino"   a company name: compared after lowercasing, removing
 *                      accents and punctuation and a trailing legal form.
 */

const LEGAL_FORMS = new Set(`
  sa sac saa sas sl slu srl sapi sab spa ltda eireli eirl cia
  ltd limited llc llp lp plc inc incorporated corp corporation co company
  gmbh ag kg ug ohg bv nv sarl sasu sprl oy ab as asa aps
  pvt private pte pty kk
`.split(/\s+/).filter(Boolean));

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** 'https://www.Acme.com/about' → 'acme.com'; not a domain → null. */
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split('/')[0].split('?')[0].split('#')[0];
  v = (v.split('@').pop() ?? '').split(':')[0].replace(/\.+$/, '');
  if (v.startsWith('www.')) v = v.slice(4);
  return DOMAIN_RE.test(v) ? v : null;
}

/** 'Grupo Andino S.A.C.' → 'grupo andino'. Empty when nothing is left. */
export function normalizeCompanyName(value: string | null | undefined): string {
  if (!value) return '';
  let v = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  v = v.replace(/&/g, ' and ');
  v = v.replace(/(?<=\w)\.(?=\w)/g, '');
  const words = v.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length > 1 && LEGAL_FORMS.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}

export class NeverContact {
  readonly emails = new Set<string>();
  readonly domains = new Set<string>();
  readonly names = new Set<string>();

  constructor(entries: readonly unknown[] | null | undefined) {
    for (const raw of entries ?? []) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const e = raw.trim().toLowerCase().replace(/^@+/, '');
      if (e.includes('@') && !e.includes(' ')) {
        this.emails.add(e);
        continue;
      }
      const d = e.includes(' ') ? null : normalizeDomain(e);
      if (d) {
        this.domains.add(d);
        continue;
      }
      const n = normalizeCompanyName(e);
      if (n) this.names.add(n);
    }
  }

  get size(): number {
    return this.emails.size + this.domains.size + this.names.size;
  }

  private domainHit(domain: string | null | undefined): string | null {
    const d = normalizeDomain(domain);
    if (!d) return null;
    const labels = d.split('.');
    for (let i = 0; i < labels.length - 1; i += 1) {
      const cand = labels.slice(i).join('.');
      if (this.domains.has(cand)) return cand;
    }
    return null;
  }

  /** The entry this person/company hits, or null. */
  match(x: { email?: string | null; domain?: string | null; companyName?: string | null }): string | null {
    if (x.email) {
      const e = x.email.trim().toLowerCase();
      if (this.emails.has(e)) return e;
      const hit = this.domainHit(e.split('@').pop());
      if (hit) return hit;
    }
    const hit = this.domainHit(x.domain);
    if (hit) return hit;
    const n = normalizeCompanyName(x.companyName);
    return n && this.names.has(n) ? n : null;
  }
}
