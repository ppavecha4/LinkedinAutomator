import { lang, locale } from '../i18n';

/** Amounts from the API are in the smallest unit (cents, paise); both currencies we charge have two decimals. */
export function formatFee(amountMinor: number, currency: string): string {
  // In English, rupees are grouped the Indian way.
  const where = lang() !== 'en' ? locale() : currency === 'INR' ? 'en-IN' : 'en-US';
  return new Intl.NumberFormat(where, { style: 'currency', currency }).format(amountMinor / 100);
}

/** A guess, only to put the likely choice first: the customer picks. */
export function looksLikeIndia(): boolean {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta';
}
