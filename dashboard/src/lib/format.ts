/**
 * Tiny formatting helpers. No external dep — we don't need date-fns / numeral
 * for Session 6.
 */

import { locale } from '../i18n';

export function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '0';
  const num = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(num)) return '0';
  return new Intl.NumberFormat(locale()).format(Math.round(num));
}

export function formatPercent(
  n: number | string | null | undefined,
  digits = 1,
): string {
  if (n === null || n === undefined || n === '') return '—';
  const num = typeof n === 'string' ? Number(n) : n;
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat(locale(), { style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(num / 100);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(locale(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(locale(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const delta = Date.now() - d.getTime();
  const seconds = Math.floor(delta / 1000);
  const ago = (value: number, unit: Intl.RelativeTimeFormatUnit) =>
    new Intl.RelativeTimeFormat(locale(), { numeric: 'always', style: 'narrow' }).format(-value, unit);
  if (seconds < 60) return ago(seconds, 'second');
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return ago(mins, 'minute');
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return ago(hrs, 'hour');
  return ago(Math.floor(hrs / 24), 'day');
}

export function num(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}
