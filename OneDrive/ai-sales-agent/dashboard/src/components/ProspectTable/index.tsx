/**
 * ProspectTable — filterable table on the /prospects page.
 */

import { formatRelative } from '../../lib/format';
import type { Contact, Prospect } from '../../lib/types';
import PitchBadge from '../PitchBadge';
import StatusBadge from '../StatusBadge';

interface Props {
  prospects: Prospect[];
  onRowClick?: (prospect: Prospect, contact: Contact | null) => void;
}

const CHANNEL_ICON: Record<string, string> = {
  email: '📧',
  linkedin: '💼',
  whatsapp: '💬',
};

function primaryContact(prospect: Prospect): Contact | null {
  if (!prospect.contacts || prospect.contacts.length === 0) return null;
  return (
    prospect.contacts.find((c) => c.is_decision_maker) ?? prospect.contacts[0]
  );
}

export default function ProspectTable({ prospects, onRowClick }: Props) {
  if (prospects.length === 0) {
    return (
      <div className="card text-center text-sm text-slate-400 py-12">
        No prospects match the current filters.
      </div>
    );
  }

  return (
    <div className="card overflow-hidden p-0">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 border-b border-slate-200">
          <tr>
            <th className="px-4 py-3 text-left">Company</th>
            <th className="px-4 py-3 text-left">Contact</th>
            <th className="px-4 py-3 text-left">Title</th>
            <th className="px-4 py-3 text-left">Pitch</th>
            <th className="px-4 py-3 text-left">Status</th>
            <th className="px-4 py-3 text-left">Last activity</th>
            <th className="px-4 py-3 text-left">Channels</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {prospects.map((p) => {
            const contact = primaryContact(p);
            return (
              <tr
                key={p.id}
                onClick={() => onRowClick?.(p, contact)}
                className="cursor-pointer hover:bg-slate-50"
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-800">{p.company_name}</div>
                  <div className="text-xs text-slate-500">{p.industry ?? '—'}</div>
                </td>
                <td className="px-4 py-3">
                  {contact ? (
                    <div>
                      <div className="text-slate-700">{contact.full_name}</div>
                      <div className="text-xs text-slate-400">{contact.email ?? '—'}</div>
                    </div>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">{contact?.title ?? '—'}</td>
                <td className="px-4 py-3">
                  <PitchBadge pitch={p.pitch_type} />
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.status} />
                </td>
                <td className="px-4 py-3 text-slate-500 text-xs">
                  {formatRelative(p.updated_at)}
                </td>
                <td className="px-4 py-3 text-lg">
                  {p.latest_message
                    ? CHANNEL_ICON[p.latest_message.channel] ?? '•'
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
