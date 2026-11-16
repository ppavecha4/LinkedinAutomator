/**
 * Slice 3.2 — never-contact matching. The cases are shared with the
 * orchestrator (services/orchestrator/tests/test_profile_rules.py): both
 * sides must decide the same way.
 */

import { describe, expect, it } from 'vitest';

import { NeverContact, normalizeCompanyName, normalizeDomain } from '../src/lib/neverContact';

const NEVER_CONTACT = ['Grupo Andino S.A.C.', 'acme.com', '@rival.pe', 'jane@gmail.com', 'https://www.Other.io/x'];
const MATCH_CASES: Array<[{ email?: string; domain?: string; companyName?: string }, string | null]> = [
  [{ email: 'x@eu.acme.com' }, 'acme.com'],
  [{ email: 'ana@rival.pe' }, 'rival.pe'],
  [{ email: 'JANE@gmail.com' }, 'jane@gmail.com'],
  [{ email: 'bob@gmail.com' }, null],
  [{ domain: 'https://other.io/about' }, 'other.io'],
  [{ domain: 'notacme.com' }, null],
  [{ companyName: 'GRUPO ANDINO SAC' }, 'grupo andino'],
  [{ companyName: 'Grupo Andino' }, 'grupo andino'],
  [{ companyName: 'Grupo Ándino S.A.' }, 'grupo andino'],
  [{ companyName: 'Grupo Andino Holdings' }, null],
];

describe('never-contact list', () => {
  const nc = new NeverContact(NEVER_CONTACT);

  it.each(MATCH_CASES)('%o → %s', (who, hit) => {
    expect(nc.match(who)).toBe(hit);
  });

  it('normalises domains and company names like the orchestrator', () => {
    expect(normalizeDomain('https://www.Acme.com/about?x=1')).toBe('acme.com');
    expect(normalizeDomain('Grupo Andino')).toBeNull();
    expect(normalizeCompanyName('Acme Holdings Pvt. Ltd.')).toBe('acme holdings');
    expect(normalizeCompanyName('Co')).toBe('co');
    expect(new NeverContact([]).size).toBe(0);
    expect(new NeverContact(['', '  ', 5, null]).size).toBe(0);
  });
});
