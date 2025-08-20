import React, { useMemo, useState } from 'react';
import { useQuery } from 'react-query';
import axios from 'axios';

const Accounts = () => {
  const [form, setForm] = useState({ label: '', loginEmail: '', sessionCookies: '', notes: '' });
  const [engine, setEngine] = useState(null);

  const { data: accounts, refetch } = useQuery('linkedin-accounts', async () => {
    const res = await axios.get('/api/linkedin-accounts');
    return res.data;
  }, { refetchOnWindowFocus: false });

  const refreshEngine = async () => {
    const res = await axios.get('/api/engine/status');
    setEngine(res.data);
  };

  React.useEffect(() => { refreshEngine(); }, []);

  const canSave = useMemo(() => form.label.trim().length > 0, [form]);

  const onCreate = async () => {
    await axios.post('/api/linkedin-accounts', form);
    setForm({ label: '', loginEmail: '', sessionCookies: '', notes: '' });
    refetch();
  };

  const onDelete = async (id) => {
    await axios.delete(`/api/linkedin-accounts/${id}`);
    refetch();
  };

  const onStartEngine = async () => {
    await axios.post('/api/engine/start');
    refreshEngine();
  };

  const onStopEngine = async () => {
    await axios.post('/api/engine/stop');
    refreshEngine();
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">LinkedIn Accounts</h1>
        <div className="flex items-center space-x-2 text-sm">
          <span className="text-gray-600">Engine:</span>
          <span className={`px-2 py-0.5 rounded ${engine?.running ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
            {engine?.running ? 'Running' : 'Stopped'}
          </span>
          <button onClick={onStartEngine} className="px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700">Start</button>
          <button onClick={onStopEngine} className="px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700">Stop</button>
        </div>
      </div>

      <div className="bg-white rounded shadow p-4">
        <h2 className="text-lg font-semibold mb-4">Add Account</h2>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Label</label>
            <input className="mt-1 block w-full rounded border-gray-300" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Login Email (optional)</label>
            <input className="mt-1 block w-full rounded border-gray-300" value={form.loginEmail} onChange={(e) => setForm({ ...form, loginEmail: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Session Cookies (optional)</label>
            <textarea rows={3} className="mt-1 block w-full rounded border-gray-300" value={form.sessionCookies} onChange={(e) => setForm({ ...form, sessionCookies: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Notes</label>
            <textarea rows={2} className="mt-1 block w-full rounded border-gray-300" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div className="flex justify-end">
            <button disabled={!canSave} onClick={onCreate} className={`px-4 py-2 rounded text-white ${canSave ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-300 cursor-not-allowed'}`}>Save</button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded shadow">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Accounts</h2>
        </div>
        <div className="divide-y">
          {accounts?.map(acc => (
            <div key={acc._id} className="p-4 flex items-center justify-between">
              <div>
                <div className="font-medium text-gray-900">{acc.label}</div>
                <div className="text-sm text-gray-500">{acc.loginEmail || '—'}</div>
              </div>
              <div className="flex items-center space-x-2">
                <button onClick={() => onDelete(acc._id)} className="px-3 py-1 rounded border text-red-700 border-red-200 hover:bg-red-50">Delete</button>
              </div>
            </div>
          ))}
          {!accounts?.length && (
            <div className="p-4 text-sm text-gray-500">No accounts yet</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Accounts;


