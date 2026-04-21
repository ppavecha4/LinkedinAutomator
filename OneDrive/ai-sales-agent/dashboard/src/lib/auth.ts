/**
 * Dev auth shim.
 *
 * The API runs with `AUTH_MODE=bypass` by default and honours `X-Dev-User` to
 * pick the fake user id for each request. In production this file is replaced
 * with a real Cognito Hosted UI redirect flow — not in scope for Session 6.
 */

export const DEV_USER_ID =
  (import.meta.env.VITE_DEV_USER_ID as string | undefined) ??
  '00000000-0000-0000-0000-000000000001';

export function getAuthToken(): string | null {
  // Placeholder — switches to Cognito token in production.
  return null;
}
