// Session 1 stub
export const CHANNELS = ['email', 'linkedin', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];
