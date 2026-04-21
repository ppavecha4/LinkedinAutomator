/**
 * Minimal modal — fixed overlay, click backdrop to close, Esc to close.
 * Keeps the dashboard dependency-free of a UI library.
 */

import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  size?: 'md' | 'lg' | 'xl';
}

const SIZES = {
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
};

export default function Modal({ open, onClose, children, title, size = 'lg' }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className={`w-full ${SIZES[size]} max-h-[90vh] overflow-hidden rounded-lg bg-white shadow-xl flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <h2 className="text-base font-semibold text-slate-800">{title}</h2>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
