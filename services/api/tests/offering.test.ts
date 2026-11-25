/**
 * Slice 2.3 — offering generation with a fake model (no network).
 */

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../src/env';
import { buildApp } from './app';
import {
  buildOfferingPrompt,
  extractJson,
  generateOffering,
  OfferingGenerationError,
} from '../src/lib/offering';

const DESCRIPTION =
  'Somos una empresa peruana de empaques para alimentos de exportación. Queremos ' +
  'llegar a jefes de compras de exportadores medianos en Emiratos, Arabia Saudita y Perú.';

const GOOD = {
  name: 'Export food packaging',
  description: 'Food-grade packaging for exporters.',
  value_proposition: 'Packaging that clears EU, US and GCC customs first time.',
  tone: 'consultative',
  icp: {
    titles: ['Head of Procurement'], industries: ['Food & Beverage'],
    company_sizes: ['51-200', '201-500'], countries: ['United Arab Emirates', 'Saudi Arabia', 'Peru'], keywords: [],
  },
  routing: {
    angles: [{ label: 'Compliance', fits: 'GCC exporters', lead_with: 'customs rejections', proof_points: [] }],
    cta: 'a 15-minute call', guardrails: ['Never quote prices'],
  },
  suggested_channels: ['linkedin', 'whatsapp', 'email', 'fax'],
  suggested_languages: ['ar', 'es', 'English', 'es-PE'],
  campaign_goal: 'Book a 15-minute call',
};

const fake = (reply: string, seen: { key?: string; prompt?: string } = {}) =>
  async (key: string, prompt: string) => {
    seen.key = key;
    seen.prompt = prompt;
    return reply;
  };

describe('offering generation', () => {
  it('turns a description into a validated draft, inside the entitlement', async () => {
    const seen: { key?: string; prompt?: string } = {};
    const draft = await generateOffering(DESCRIPTION, {
      apiKey: 'org-key',
      allowedChannels: ['email', 'whatsapp', 'voice'],
      callModel: fake('Here you go:\n```json\n' + JSON.stringify(GOOD) + '\n```', seen),
    });
    expect(seen.key).toBe('org-key');
    expect(seen.prompt).toContain('Somos una empresa peruana');
    expect(draft.offering).toMatchObject({ name: 'Export food packaging', tone: 'consultative' });
    expect(draft.offering.routing.angles[0].label).toBe('Compliance');
    // LinkedIn (not entitled) and junk are dropped; languages must be codes.
    expect(draft.suggested_channels).toEqual(['whatsapp', 'email']);
    expect(draft.suggested_languages).toEqual(['ar', 'es', 'es-PE']);
    expect(draft.campaign_goal).toBe('Book a 15-minute call');
  });

  it('falls back to a sensible channel and goal when the model omits them', async () => {
    const { suggested_channels, campaign_goal, ...minimal } = GOOD;
    void suggested_channels; void campaign_goal;
    const draft = await generateOffering(DESCRIPTION, {
      apiKey: 'k', allowedChannels: ['email', 'whatsapp', 'voice'], callModel: fake(JSON.stringify(minimal)),
    });
    expect(draft.suggested_channels).toEqual(['email']);
    expect(draft.campaign_goal).toMatch(/call/);
  });

  it('rejects replies that are not usable offerings', async () => {
    const opts = { apiKey: 'k', allowedChannels: ['email' as const] };
    await expect(generateOffering(DESCRIPTION, { ...opts, callModel: fake('Sorry, I cannot help.') }))
      .rejects.toBeInstanceOf(OfferingGenerationError);
    await expect(generateOffering(DESCRIPTION, { ...opts, callModel: fake(JSON.stringify({ name: 'x' })) }))
      .rejects.toBeInstanceOf(OfferingGenerationError);
    await expect(generateOffering(DESCRIPTION, {
      ...opts, callModel: async () => { throw new Error('model call failed (529)'); },
    })).rejects.toThrow(/could not draft/);
  });

  it('the prompt forbids invented claims and lists only allowed channels', () => {
    const p = buildOfferingPrompt('We sell X', ['email', 'whatsapp', 'voice']);
    expect(p).toMatch(/Do not invent/);
    expect(p).toContain('["email","whatsapp","voice"]');
    expect(p).not.toContain('linkedin');
  });

  it('extractJson finds the object inside fences or prose', () => {
    expect(extractJson('blah {"a": {"b": 1}} trailing')).toEqual({ a: { b: 1 } });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('Appson-only planner route', () => {
  const original = { ...env };
  afterEach(() => Object.assign(env, original));

  it('customers are pointed to the offering generator (no Appson plan, no platform key)', async () => {
    env.authMode = 'bypass';
    const res = await request(buildApp())
      .post('/api/campaigns/plan')
      .set('x-dev-org', '67676767-6767-4676-8676-676767676767')
      .send({ goal: 'find exporters in Peru' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/offerings\/generate/);
  });
});
