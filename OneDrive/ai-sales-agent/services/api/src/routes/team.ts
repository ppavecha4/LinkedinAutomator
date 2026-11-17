/**
 * Team management (SaaS phase 3, slice 3.6). Owner and admin only.
 *
 *   GET    /api/team                         members + open invitations
 *   POST   /api/team/invites                 {email, role} → invitation link
 *   DELETE /api/team/invites/:id             withdraw an invitation
 *   PATCH  /api/team/members/:userId         {role}
 *   DELETE /api/team/members/:userId         remove from this organization
 *   POST   /api/team/members/:userId/reset-link   password-reset link to hand over
 *
 * Who may do what: an owner manages everyone but other owners; an admin
 * manages members and viewers only (and can invite members and viewers).
 * Nobody changes or removes themselves here, and owners are never touched
 * (ownership transfer is a platform-admin job). Role changes and removals
 * end that person's access immediately (lib/sessionState.ts).
 *
 * With platform email configured the invitation / reset link is also
 * emailed; either way the API returns it so the inviter can pass it on.
 */

import { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/client';
import { env } from '../env';
import { issueToken, RESET_TTL_MINUTES } from '../lib/accountTokens';
import { ApiError } from '../lib/errors';
import { dashboardLink, mailerConfigured, sendMail } from '../lib/mailer';
import { ok } from '../lib/response';
import { forgetSession } from '../lib/sessionState';
import { newToken } from '../lib/tokens';
import { logger } from '../logger';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();
const manage = requireRole('owner', 'admin');

const INVITE_ROLES = ['admin', 'member', 'viewer'] as const;
type InviteRole = (typeof INVITE_ROLES)[number];
const idParams = z.object({ id: z.string().uuid() });
const userParams = z.object({ userId: z.string().uuid() });

/** Roles the caller may hand out or manage. */
function manageable(callerRole: string | undefined): InviteRole[] {
  return callerRole === 'owner' ? ['admin', 'member', 'viewer'] : ['member', 'viewer'];
}

interface MemberRow {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  last_login_at: string | null;
  email_verified: boolean;
}

async function member(userId: string): Promise<MemberRow> {
  const r = await query<MemberRow>(
    `SELECT u.id AS user_id, u.email, u.full_name, m.role, u.last_login_at, (u.email_verified_at IS NOT NULL) AS email_verified
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1`, [userId]);
  if (!r.rows[0]) throw ApiError.notFound('that person is not in your team');
  return r.rows[0];
}

/** The target must be someone this caller may manage, and not themselves. */
function assertCanManage(req: Request, target: MemberRow): void {
  if (target.user_id === req.user!.id) throw ApiError.badRequest('you cannot change your own access here');
  if (target.role === 'owner') throw ApiError.forbidden('the owner cannot be changed here');
  if (!manageable(req.user!.role).includes(target.role as InviteRole)) {
    throw ApiError.forbidden('only an owner can manage admins');
  }
}

router.get('/api/team', manage, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const members = await query<MemberRow>(
      `SELECT u.id AS user_id, u.email, u.full_name, m.role, u.last_login_at, (u.email_verified_at IS NOT NULL) AS email_verified
         FROM memberships m JOIN users u ON u.id = m.user_id
        ORDER BY (m.role = 'owner') DESC, lower(u.email)`);
    const invites = await query(
      `SELECT i.id, i.email, i.role, i.created_at, i.expires_at, inv.full_name AS invited_by_name
         FROM org_invites i LEFT JOIN users inv ON inv.id = i.invited_by
        WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
        ORDER BY i.created_at DESC`);
    return ok(res, {
      members: members.rows.map((m) => ({ ...m, is_you: m.user_id === req.user!.id })),
      invites: invites.rows,
      can_invite_roles: manageable(req.user!.role),
      email_enabled: mailerConfigured(),
    });
  } catch (e) {
    next(e);
  }
});

const inviteBody = z
  .object({ email: z.string().trim().toLowerCase().email().max(255), role: z.enum(INVITE_ROLES) })
  .strict();

router.post('/api/team/invites', manage, validate({ body: inviteBody }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, role } = req.validated!.body as z.infer<typeof inviteBody>;
    if (!manageable(req.user!.role).includes(role)) throw ApiError.forbidden('only an owner can invite admins');
    const already = await query(
      `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE lower(u.email) = $1`, [email]);
    if (already.rowCount) throw ApiError.conflict('that person is already in your team');

    const { token, hash } = newToken();
    // Replace any open invitation for this address: revoke it, then insert
    // (two statements: the unique index would not see them as one).
    const created = await withTransaction(async (client) => {
      await client.query(
        `UPDATE org_invites SET revoked_at = now()
          WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [email]);
      return client.query<{ id: string; email: string; role: string; created_at: string; expires_at: string }>(
        `INSERT INTO org_invites (email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
         RETURNING id, email, role, created_at, expires_at`,
        [email, role, hash, req.user!.id, env.inviteTtlDays],
      );
    });
    const link = dashboardLink('/accept-invite', token);
    let emailed = false;
    let emailError: string | undefined;
    if (mailerConfigured()) {
      try {
        const org = await query<{ name: string }>(`SELECT name FROM organizations`);
        await sendMail({
          to: email,
          subject: `You're invited to ${org.rows[0]?.name ?? 'a team'} on AI Sales Agent`,
          text: `You've been invited to join ${org.rows[0]?.name ?? 'a team'} as ${role}.\n\nAccept here:\n\n${link}\n\nThe link works once, for ${env.inviteTtlDays} days.\n`,
        });
        emailed = true;
      } catch (e) {
        emailError = 'the email could not be sent; share the link yourself';
        logger.warn('invite email failed', { error: (e as Error).message });
      }
    }
    return ok(res, { invite: created.rows[0], link, emailed, ...(emailError ? { email_error: emailError } : {}) }, 201);
  } catch (e) {
    next(e);
  }
});

router.delete('/api/team/invites/:id', manage, validate({ params: idParams }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.validated!.params as z.infer<typeof idParams>;
    const r = await query(
      `UPDATE org_invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [id]);
    if (!r.rowCount) throw ApiError.notFound('invitation not found');
    return ok(res, { ok: true });
  } catch (e) {
    next(e);
  }
});

const roleBody = z.object({ role: z.enum(INVITE_ROLES) }).strict();

router.patch('/api/team/members/:userId', manage, validate({ params: userParams, body: roleBody }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.validated!.params as z.infer<typeof userParams>;
    const { role } = req.validated!.body as z.infer<typeof roleBody>;
    const target = await member(userId);
    assertCanManage(req, target);
    if (!manageable(req.user!.role).includes(role)) throw ApiError.forbidden('only an owner can make someone an admin');
    await query(`UPDATE memberships SET role = $2 WHERE user_id = $1`, [userId, role]);
    forgetSession(userId);
    return ok(res, { ...target, role });
  } catch (e) {
    next(e);
  }
});

router.delete('/api/team/members/:userId', manage, validate({ params: userParams }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.validated!.params as z.infer<typeof userParams>;
    const target = await member(userId);
    assertCanManage(req, target);
    await query(`DELETE FROM memberships WHERE user_id = $1`, [userId]);
    forgetSession(userId);
    return ok(res, { ok: true });
  } catch (e) {
    next(e);
  }
});

router.post('/api/team/members/:userId/reset-link', manage, validate({ params: userParams }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.validated!.params as z.infer<typeof userParams>;
    const target = await member(userId);
    assertCanManage(req, target);
    const link = dashboardLink('/reset-password', await issueToken(userId, 'reset'));
    let emailed = false;
    if (mailerConfigured()) {
      try {
        await sendMail({
          to: target.email,
          subject: 'Reset your password',
          text: `Your administrator started a password reset for you. Choose a new password here:\n\n${link}\n\nThe link works once, for ${RESET_TTL_MINUTES} minutes.\n`,
        });
        emailed = true;
      } catch (e) {
        logger.warn('reset email failed', { error: (e as Error).message });
      }
    }
    return ok(res, { link, emailed, expires_in_minutes: RESET_TTL_MINUTES });
  } catch (e) {
    next(e);
  }
});

export default router;
