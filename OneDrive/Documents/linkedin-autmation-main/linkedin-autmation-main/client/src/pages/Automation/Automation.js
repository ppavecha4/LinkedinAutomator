import React, { useMemo, useState } from 'react';
import { useQuery } from 'react-query';
import axios from 'axios';
import { PlusIcon, PlayIcon, StopIcon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline';

const Automation = () => {
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    type: 'connection_request',
    account: ''
  });

  const { data: automations, isLoading, refetch } = useQuery(
    'automations',
    async () => {
      const response = await axios.get('/api/automation');
      return response.data;
    },
    {
      refetchOnWindowFocus: false,
    }
  );

  const { data: accounts } = useQuery(
    'linkedin-accounts',
    async () => {
      const response = await axios.get('/api/linkedin-accounts');
      return response.data;
    },
    { refetchOnWindowFocus: false }
  );

  const handleStartAutomation = async (id) => {
    try {
      await axios.post(`/api/automation/${id}/start`);
      refetch();
    } catch (error) {
      console.error('Failed to start automation:', error);
    }
  };

  const handleStopAutomation = async (id) => {
    try {
      await axios.post(`/api/automation/${id}/stop`);
      refetch();
    } catch (error) {
      console.error('Failed to stop automation:', error);
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'active':
        return 'bg-green-100 text-green-800';
      case 'paused':
        return 'bg-red-100 text-red-800';
      case 'draft':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const canCreate = useMemo(() => {
    return formData.name.trim().length > 0 && formData.type && formData.account;
  }, [formData]);

  const handleCreate = async () => {
    try {
      await axios.post('/api/automation', {
        name: formData.name,
        description: formData.description || undefined,
        type: formData.type,
        account: formData.account
      });
      setIsCreating(false);
      setFormData({ name: '', description: '', type: 'connection_request', account: '' });
      refetch();
    } catch (error) {
      console.error('Failed to create automation:', error);
    }
  };

  const handleDeleteAutomation = async (id) => {
    try {
      await axios.delete(`/api/automation/${id}`);
      refetch();
    } catch (error) {
      console.error('Failed to delete automation:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Automations</h1>
        <button
          onClick={() => setIsCreating(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
        >
          <PlusIcon className="h-4 w-4 mr-2" />
          New Automation
        </button>
      </div>

      {isCreating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-30">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-lg">
            <div className="px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">Create Automation</h2>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Description</label>
                <textarea
                  rows={2}
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Type</label>
                <select
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                >
                  <option value="connection_request">Connection request</option>
                  <option value="message_send">Message send</option>
                  <option value="follow_up">Follow up</option>
                  <option value="campaign">Campaign</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">LinkedIn account</label>
                <select
                  value={formData.account}
                  onChange={(e) => setFormData({ ...formData, account: e.target.value })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-primary-500 focus:ring-primary-500"
                >
                  <option value="">Select account</option>
                  {accounts?.map(acc => (
                    <option key={acc._id} value={acc._id}>{acc.label} {acc.loginEmail ? `(${acc.loginEmail})` : ''}</option>
                  ))}
                </select>
              </div>
              
            </div>
            <div className="px-6 py-4 border-t flex justify-end space-x-2">
              <button
                onClick={() => { setIsCreating(false); setFormData({ name: '', description: '', type: 'connection_request', account: '' }); }}
                className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!canCreate}
                className={`px-4 py-2 rounded-md text-white ${canCreate ? 'bg-primary-600 hover:bg-primary-700' : 'bg-gray-300 cursor-not-allowed'}`}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white shadow overflow-hidden sm:rounded-md">
        {automations && automations.length > 0 ? (
          <ul className="divide-y divide-gray-200">
            {automations.map((automation) => (
              <li key={automation._id} className="px-6 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center">
                      <h3 className="text-lg font-medium text-gray-900">
                        {automation.name}
                      </h3>
                      <span className={`ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(automation.status)}`}>
                        {automation.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      Type: {automation.type} • Account: {automation.account?.label || '—'} • Created: {new Date(automation.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex space-x-2">
                    {automation.status === 'draft' && (
                      <button
                        onClick={() => handleStartAutomation(automation._id)}
                        className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-white bg-green-600 hover:bg-green-700"
                      >
                        <PlayIcon className="h-4 w-4 mr-1" />
                        Start
                      </button>
                    )}
                    {automation.status === 'active' && (
                      <button
                        onClick={() => handleStopAutomation(automation._id)}
                        className="inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700"
                      >
                        <StopIcon className="h-4 w-4 mr-1" />
                        Stop
                      </button>
                    )}
                    <button className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">
                      <PencilIcon className="h-4 w-4 mr-1" />
                      Edit
                    </button>
                    <button
                      onClick={() => handleDeleteAutomation(automation._id)}
                      className="inline-flex items-center px-3 py-1 border border-gray-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50"
                    >
                      <TrashIcon className="h-4 w-4 mr-1" />
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-center py-12">
            <h3 className="text-lg font-medium text-gray-900 mb-2">No automations yet</h3>
            <p className="text-gray-500 mb-4">Create your first automation to get started</p>
            <button
              onClick={() => setIsCreating(true)}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700"
            >
              <PlusIcon className="h-4 w-4 mr-2" />
              Create Automation
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Automation; 