/**
 * Hands the file chosen in the new-campaign wizard to the import page.
 * In memory only: a page reload drops it and the import page simply asks
 * for the file again.
 */

let pending: { campaignId: string; file: File } | null = null;

export function setPendingImport(campaignId: string, file: File): void {
  pending = { campaignId, file };
}

/** The file waiting for this campaign, once (it is cleared on read). */
export function takePendingImport(campaignId: string): File | null {
  if (pending?.campaignId !== campaignId) return null;
  const f = pending.file;
  pending = null;
  return f;
}
