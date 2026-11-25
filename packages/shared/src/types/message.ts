// Shared Message type — session 1 stub
export interface Message {
  id: string;
  channel: 'email' | 'linkedin' | 'whatsapp';
  body: string;
}
