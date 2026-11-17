/**
 * Phase 2 slice 1 — channel rules that need no database.
 */

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../src/env';
import type { CampaignPlan } from '../src/lib/campaignPlanner';
import { assertFollowUps, assertStepsWithin, channelsFromSteps } from '../src/lib/channels';
import { ApiError } from '../src/lib/errors';
import { restrictPlanToChannels } from '../src/routes/campaigns';
import { buildApp } from './app';

describe('follow-up steps (slice 3.5)', () => {
  const fu = (step_number: number, delay_days: number, channel: 'email' | 'whatsapp' = 'email') =>
    ({ step_number, channel, action: 'follow_up', delay_days });

  it('accepts email and WhatsApp follow-ups that grow in delay per channel, ignores other actions', () => {
    expect(() => assertFollowUps([fu(2, 3), fu(3, 7)])).not.toThrow();
    // Each channel has its own clock: WhatsApp can start again at day 3.
    expect(() => assertFollowUps([fu(2, 3), fu(3, 7), fu(12, 3, 'whatsapp'), fu(13, 7, 'whatsapp')])).not.toThrow();
    // Appson's older steps are named "Follow-up 1" etc. and are not checked.
    expect(() => assertFollowUps([{ step_number: 1, channel: 'email', action: 'Follow-up 1', delay_days: 0 }])).not.toThrow();
    expect(() => assertFollowUps([])).not.toThrow();
  });

  it.each([
    [[{ step_number: 2, channel: 'linkedin' as never, action: 'follow_up', delay_days: 3 }], /email and WhatsApp/],
    [[fu(12, 7, 'whatsapp'), fu(13, 3, 'whatsapp')], /later than the one before/],
    [[fu(1, 3)], /step 2 onwards/],
    [[fu(2, 0)], /1–90 days/],
    [[fu(2, 91)], /1–90 days/],
    [[fu(2, 7), fu(3, 7)], /later than the one before/],
    [[fu(2, 7), fu(3, 3)], /later than the one before/],
    [[fu(2, 1), fu(3, 2), fu(4, 3), fu(5, 4), fu(6, 5), fu(7, 6)], /at most 5 follow-ups per channel/],
  ])('rejects %j', (steps, msg) => {
    expect(() => assertFollowUps(steps)).toThrow(msg);
  });
});

describe('channel helpers', () => {
  it('derives channels from steps, distinct, in step order', () => {
    expect(
      channelsFromSteps([
        { channel: 'whatsapp' },
        { channel: 'email' },
        { channel: 'whatsapp' },
      ]),
    ).toEqual(['whatsapp', 'email']);
  });

  it('rejects steps outside the campaign channels, naming them', () => {
    expect(() =>
      assertStepsWithin(
        [
          { step_number: 1, channel: 'email' },
          { step_number: 2, channel: 'linkedin' },
        ],
        ['email', 'whatsapp'],
      ),
    ).toThrow(ApiError);
    try {
      assertStepsWithin([{ step_number: 2, channel: 'linkedin' }], ['email']);
    } catch (e) {
      expect((e as ApiError).status).toBe(400);
      expect(JSON.stringify((e as ApiError).details)).toContain('linkedin');
    }
  });
});

describe('AI plans stay inside the entitlement', () => {
  const plan = {
    channels_enabled: ['linkedin', 'email'],
    sequence_steps: [
      { step_number: 1, channel: 'linkedin', action: 'Connect', delay_days: 0 },
      { step_number: 2, channel: 'email', action: 'Intro', delay_days: 2 },
      { step_number: 3, channel: 'email', action: 'Follow-up', delay_days: 5 },
    ],
  } as unknown as CampaignPlan;

  it('drops LinkedIn and renumbers for a customer org', () => {
    const out = restrictPlanToChannels(plan, ['email', 'whatsapp', 'voice']);
    expect(out.channels_enabled).toEqual(['email']);
    expect(out.sequence_steps.map((s) => [s.step_number, s.channel])).toEqual([
      [1, 'email'],
      [2, 'email'],
    ]);
  });

  it('leaves Appson\'s plan untouched', () => {
    const out = restrictPlanToChannels(plan, ['email', 'whatsapp', 'linkedin', 'voice']);
    expect(out.channels_enabled).toEqual(['linkedin', 'email']);
    expect(out.sequence_steps).toHaveLength(3);
  });

  it('never returns an empty channel list', () => {
    const linkedinOnly = { ...plan, channels_enabled: ['linkedin'] } as unknown as CampaignPlan;
    expect(restrictPlanToChannels(linkedinOnly, ['email', 'whatsapp']).channels_enabled).toEqual(['email']);
  });
});

describe('routes: checks before the database', () => {
  const original = { ...env };
  afterEach(() => Object.assign(env, original));

  it('campaign create rejects a step outside the chosen channels', async () => {
    env.authMode = 'bypass';
    const res = await request(buildApp()).post('/api/campaigns').send({
      name: 'x', goal: 'g', sender_company: 'c', sender_name: 'n', value_proposition: 'vp',
      channels: ['email'],
      sequence_steps: [{ step_number: 1, channel: 'whatsapp', action: 'hi' }],
    });
    expect(res.status).toBe(400);
  });

  it('campaign create rejects unknown channels, empty lists and bad language codes', async () => {
    env.authMode = 'bypass';
    const app = buildApp();
    const base = { name: 'x', goal: 'g', sender_company: 'c', sender_name: 'n', value_proposition: 'vp' };
    expect((await request(app).post('/api/campaigns').send({ ...base, channels: ['fax'] })).status).toBe(400);
    expect((await request(app).post('/api/campaigns').send({ ...base, channels: [] })).status).toBe(400);
    expect((await request(app).post('/api/campaigns').send({ ...base, languages: ['Spanish'] })).status).toBe(400);
  });

  it('organization settings: viewers cannot edit; bad values are rejected', async () => {
    env.authMode = 'bypass';
    const app = buildApp();
    const viewer = await request(app).patch('/api/organization').set('x-dev-role', 'viewer').send({ name: 'x' });
    expect(viewer.status).toBe(403);
    for (const body of [
      { timezone: 'Mars/Olympus' },
      { default_country: 'UAE' },
      { default_language: 'English' },
      { channels: ['linkedin'] }, // entitlement is not customer-editable
      {},
    ]) {
      const res = await request(app).patch('/api/organization').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});
