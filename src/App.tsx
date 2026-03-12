import React, { useState, useCallback, useEffect } from 'react';
import { 
  Mail, 
  Plus, 
  Users, 
  FileText, 
  Settings, 
  Send, 
  Trash2, 
  Upload, 
  Clock, 
  Layout, 
  ChevronRight,
  Code,
  Eye,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { useDropzone } from 'react-dropzone';
import Papa from 'papaparse';
import { formatInTimeZone } from 'date-fns-tz';

// --- Types ---
interface Contact {
  email: string;
  name: string;
  timezone: string;
  [key: string]: string;
}

interface Template {
  id: string;
  name: string;
  subject: string;
  content: string;
  isHtml: boolean;
}

interface Account {
  id: string;
  email: string;
  provider: 'outlook' | 'smtp';
  status: 'connected' | 'disconnected';
  config?: {
    smtpHost: string;
    smtpPort: number;
    imapHost: string;
    imapPort: number;
    password?: string;
  };
}

// --- Components ---

const SidebarItem = ({ icon: Icon, label, active, onClick }: { icon: any, label: string, active?: boolean, onClick: () => void }) => (
  <button 
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-4 py-2 text-sm font-medium transition-colors rounded-lg ${
      active ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'
    }`}
  >
    <Icon size={18} />
    {label}
  </button>
);

interface CampaignStatus {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  total: number;
  sent: number;
  failed: number;
  opens?: number;
  clicks?: number;
  logs: string[];
  startTime: string;
  endTime?: string;
  templateId: string;
  accountId: string;
  contacts: Contact[];
  settings: {
    maxPerMin: number;
    useJitter: boolean;
    batchSize: number;
    batchCooling: number;
  };
}

export default function App() {
  const [notifications, setNotifications] = useState<{id: string, type: 'success' | 'error' | 'info', message: string}[]>([]);
  const [activeTab, setActiveTab] = useState<'accounts' | 'templates' | 'campaigns' | 'settings'>('campaigns');
  const [templates, setTemplates] = useState<Template[]>([
    { id: '1', name: 'Welcome Email', subject: 'Welcome to our service, {{name}}!', content: '<h1>Hello {{name}}</h1><p>Glad to have you here.</p>', isHtml: true }
  ]);
  const [accounts, setAccounts] = useState<Account[]>([
    { id: '1', email: 'user@outlook.com', provider: 'outlook', status: 'connected' }
  ]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [selectedAccount, setSelectedAccount] = useState<string>('');
  const [isSending, setIsSending] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [activeCampaign, setActiveCampaign] = useState<CampaignStatus | null>(null);
  const [campaignHistory, setCampaignHistory] = useState<CampaignStatus[]>([]);
  const [campaignName, setCampaignName] = useState('');
  const [showManualSetup, setShowManualSetup] = useState(false);
  const [showSendingSettings, setShowSendingSettings] = useState(false);
  const [sendingSettings, setSendingSettings] = useState({
    maxPerMin: 10,
    useJitter: true,
    batchSize: 50,
    batchCooling: 5, // minutes
    enableOpenTracking: false,
    enableClickTracking: false,
    isScheduled: false,
    scheduledTime: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });

  // --- Persistence ---
  useEffect(() => {
    const savedAccounts = localStorage.getItem('email_accounts');
    const savedTemplates = localStorage.getItem('email_templates');
    const savedHistory = localStorage.getItem('campaign_history');
    
    if (savedAccounts) setAccounts(JSON.parse(savedAccounts));
    if (savedTemplates) setTemplates(JSON.parse(savedTemplates));
    if (savedHistory) setCampaignHistory(JSON.parse(savedHistory));
  }, []);

  useEffect(() => {
    localStorage.setItem('email_accounts', JSON.stringify(accounts));
  }, [accounts]);

  useEffect(() => {
    localStorage.setItem('email_templates', JSON.stringify(templates));
  }, [templates]);

  useEffect(() => {
    localStorage.setItem('campaign_history', JSON.stringify(campaignHistory));
  }, [campaignHistory]);
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [templateForm, setTemplateForm] = useState<Omit<Template, 'id'>>({
    name: '',
    subject: '',
    content: '',
    isHtml: true
  });
  const [manualConfig, setManualConfig] = useState({
    email: '',
    password: '',
    smtpHost: 'smtp.partner.outlook.cn',
    smtpPort: 587,
    imapHost: 'partner.outlook.cn',
    imapPort: 993
  });

  const addNotification = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString();
    setNotifications(prev => [...prev, { id, type, message }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 5000);
  };

  // OAuth Listener
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Basic origin check (could be more strict)
      if (!event.origin.includes('run.app') && !event.origin.includes('localhost')) return;

      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const { email, id } = event.data.payload;
        const newAccount: Account = {
          id: id || Date.now().toString(),
          email: email,
          provider: 'outlook',
          status: 'connected'
        };
        
        setAccounts(prev => {
          // Avoid duplicates
          if (prev.find(a => a.email === email)) return prev;
          return [...prev, newAccount];
        });
        
        setIsConnecting(false);
        addNotification(`Successfully connected account: ${email}`, 'success');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleManualConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!manualConfig.email || !manualConfig.password) {
      addNotification('Email and password are required', 'error');
      return;
    }

    setIsConnecting(true);
    try {
      const response = await fetch('/api/accounts/verify-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manualConfig)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `Server Error (${response.status})`;
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorMessage;
        } catch (e) {
          // Not JSON, use status text
          errorMessage = response.statusText || errorMessage;
        }
        addNotification('Connection failed: ' + errorMessage, 'error');
        return;
      }

      const data = await response.json();
      if (data.success) {
        const newAccount: Account = {
          id: Date.now().toString(),
          email: manualConfig.email,
          provider: 'smtp',
          status: 'connected',
          config: { ...manualConfig }
        };
        setAccounts(prev => [...prev, newAccount]);
        setShowManualSetup(false);
        addNotification('Account connected successfully via SMTP/IMAP', 'success');
      } else {
        addNotification('Connection failed: ' + (data.error || 'Unknown error'), 'error');
      }
    } catch (error: any) {
      console.error('Manual connect error:', error);
      addNotification(`Request failed: ${error.message || 'Please check if the server is running'}`, 'error');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const response = await fetch('/api/auth/microsoft/url');
      if (!response.ok) throw new Error('Failed to get auth URL');
      const { url } = await response.json();

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.innerWidth - width) / 2;
      const top = window.screenY + (window.innerHeight - height) / 2;

      const authWindow = window.open(
        url,
        'microsoft_oauth',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      if (!authWindow) {
        addNotification('Popup blocked! Please allow popups for this site.', 'error');
        setIsConnecting(false);
      }
    } catch (error) {
      console.error('Connect error:', error);
      addNotification('Failed to initiate connection.', 'error');
      setIsConnecting(false);
    }
  };

  // CSV Upload Handler
  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    Papa.parse(file, {
      header: true,
      complete: (results) => {
        setContacts(results.data as Contact[]);
      }
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: { 'text/csv': ['.csv'] } });

  const handleSend = async () => {
    if (!selectedTemplate || !selectedAccount || contacts.length === 0) {
      addNotification('Please select a template, account, and upload contacts.', 'error');
      return;
    }
    
    const account = accounts.find(a => a.id === selectedAccount);
    const template = templates.find(t => t.id === selectedTemplate);

    if (!account || !template) return;

    if (!showSendingSettings) {
      if (!campaignName) {
        setCampaignName(`${template.name} - ${new Date().toLocaleDateString()}`);
      }
      setShowSendingSettings(true);
      return;
    }

    setIsSending(true);
    try {
      const response = await fetch('/api/send-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template,
          contacts,
          accountConfig: account.config || { email: account.email },
          settings: {
            ...sendingSettings,
            name: campaignName,
            scheduledTime: sendingSettings.isScheduled ? sendingSettings.scheduledTime : null,
            timezone: sendingSettings.timezone
          }
        })
      });
      
      const data = await response.json();
      if (data.success) {
        if (sendingSettings.isScheduled) {
          addNotification(`Campaign scheduled for ${sendingSettings.scheduledTime} (${sendingSettings.timezone})`, 'success');
        } else {
          addNotification('Campaign started successfully!', 'success');
        }
        
        const newCampaign: CampaignStatus = {
          id: data.campaignId,
          name: campaignName,
          status: sendingSettings.isScheduled ? 'stopped' : 'running', // Use stopped as a placeholder for scheduled
          total: contacts.length,
          sent: 0,
          failed: 0,
          logs: [sendingSettings.isScheduled ? `Campaign scheduled for ${sendingSettings.scheduledTime}` : 'Campaign initialized'],
          startTime: new Date().toISOString(),
          templateId: selectedTemplate,
          accountId: selectedAccount,
          contacts: contacts,
          settings: {
            maxPerMin: sendingSettings.maxPerMin,
            useJitter: sendingSettings.useJitter,
            batchSize: sendingSettings.batchSize,
            batchCooling: sendingSettings.batchCooling
          }
        };
        
        setCampaignHistory(prev => {
          const updated = [newCampaign, ...prev];
          return updated.slice(0, 10);
        });

        if (!sendingSettings.isScheduled) {
          setActiveCampaign(newCampaign);
          startPolling(data.campaignId);
        }
        
        setShowSendingSettings(false);
        setCampaignName('');
      } else {
        addNotification('Failed to start campaign: ' + (data.error || 'Unknown error'), 'error');
        setIsSending(false);
      }
    } catch (error: any) {
      console.error('Send error:', error);
      addNotification('Network error while starting campaign.', 'error');
      setIsSending(false);
    }
  };

  const handleSaveTemplate = () => {
    if (!templateForm.name || !templateForm.subject) {
      addNotification('Name and Subject are required', 'error');
      return;
    }

    if (editingTemplate) {
      setTemplates(prev => prev.map(t => t.id === editingTemplate.id ? { ...templateForm, id: t.id } : t));
      addNotification('Template updated successfully', 'success');
    } else {
      const newTemplate: Template = {
        ...templateForm,
        id: Date.now().toString()
      };
      setTemplates(prev => [...prev, newTemplate]);
      addNotification('Template created successfully', 'success');
    }
    setShowTemplateEditor(false);
    setEditingTemplate(null);
    setTemplateForm({ name: '', subject: '', content: '', isHtml: true });
  };

  const handleEditTemplate = (template: Template) => {
    setEditingTemplate(template);
    setTemplateForm({
      name: template.name,
      subject: template.subject,
      content: template.content,
      isHtml: template.isHtml
    });
    setShowTemplateEditor(true);
  };

  const handleDeleteTemplate = (id: string) => {
    if (confirm('Are you sure you want to delete this template?')) {
      setTemplates(prev => prev.filter(t => t.id !== id));
      addNotification('Template deleted', 'info');
    }
  };

  const handleFollowUp = (campaign: CampaignStatus) => {
    setContacts(campaign.contacts);
    setSelectedAccount(campaign.accountId);
    setCampaignName(`Follow-up: ${campaign.name}`);
    setActiveTab('campaigns');
    addNotification('Contacts and account loaded for follow-up. Select a new template to continue.', 'info');
  };

  const startPolling = (id: string) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/campaigns/${id}`);
        const data = await res.json();
        
        setActiveCampaign(data);
        setCampaignHistory(prev => prev.map(c => c.id === id ? { ...c, ...data } : c));
        
        if (data.status === 'completed' || data.status === 'stopped' || data.status === 'failed') {
          clearInterval(interval);
          setIsSending(false);
        }
      } catch (e) {
        clearInterval(interval);
        setIsSending(false);
      }
    }, 2000);
  };

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 font-sans">
      {/* Notifications */}
      <div className="fixed top-4 right-4 z-[100] space-y-2 pointer-events-none">
        {notifications.map(n => (
          <div 
            key={n.id} 
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border animate-in slide-in-from-right-full duration-300 ${
              n.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
              n.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' :
              'bg-blue-50 border-blue-200 text-blue-800'
            }`}
          >
            {n.type === 'success' ? <CheckCircle2 size={18} /> : 
             n.type === 'error' ? <AlertCircle size={18} /> : 
             <Clock size={18} />}
            <p className="text-sm font-medium">{n.message}</p>
          </div>
        ))}
      </div>

      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 flex items-center gap-2 border-bottom border-gray-100">
          <div className="bg-blue-600 p-2 rounded-lg">
            <Mail className="text-white" size={24} />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-gray-800">ThunderSend</h1>
        </div>
        
        <nav className="flex-1 px-4 py-4 space-y-1">
          <SidebarItem icon={Send} label="Campaigns" active={activeTab === 'campaigns'} onClick={() => setActiveTab('campaigns')} />
          <SidebarItem icon={FileText} label="Templates" active={activeTab === 'templates'} onClick={() => setActiveTab('templates')} />
          <SidebarItem icon={Users} label="Accounts" active={activeTab === 'accounts'} onClick={() => setActiveTab('accounts')} />
          <SidebarItem icon={Settings} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
        </nav>

        <div className="p-4 border-t border-gray-100">
          <div className="bg-gray-50 rounded-xl p-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Active Account</p>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <p className="text-sm font-medium truncate">{accounts[0]?.email}</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <header className="bg-white border-b border-gray-200 px-8 py-4 flex justify-between items-center sticky top-0 z-10">
          <h2 className="text-lg font-semibold capitalize">{activeTab}</h2>
          <div className="flex gap-3">
            {activeTab === 'campaigns' && (
              <button 
                onClick={handleSend}
                disabled={isSending}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium transition-all shadow-sm disabled:opacity-50"
              >
                {isSending ? <Clock className="animate-spin" size={18} /> : <Send size={18} />}
                {isSending ? 'Sending...' : 'Start Campaign'}
              </button>
            )}
            <button className="p-2 hover:bg-gray-100 rounded-lg text-gray-500">
              <Plus size={20} />
            </button>
          </div>
        </header>

        <div className="p-8 max-w-5xl mx-auto">
          {activeTab === 'campaigns' && (
            <div className="space-y-6">
              {/* Campaign Progress Dashboard */}
              {activeCampaign && (
                <div className="bg-white p-6 rounded-2xl border-2 border-blue-100 shadow-xl overflow-hidden relative">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
                        <Layout className="text-blue-600" />
                        Campaign Progress
                      </h3>
                      <p className="text-sm text-gray-500">ID: {activeCampaign.id} | Name: {activeCampaign.name}</p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                      activeCampaign.status === 'running' ? 'bg-blue-100 text-blue-600 animate-pulse' : 'bg-green-100 text-green-600'
                    }`}>
                      {activeCampaign.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-5 gap-4 mb-6">
                    <div className="bg-gray-50 p-4 rounded-xl text-center">
                      <p className="text-xs font-bold text-gray-400 uppercase">Total</p>
                      <p className="text-2xl font-black text-gray-800">{activeCampaign.total}</p>
                    </div>
                    <div className="bg-green-50 p-4 rounded-xl text-center">
                      <p className="text-xs font-bold text-green-400 uppercase">Sent</p>
                      <p className="text-2xl font-black text-green-600">{activeCampaign.sent}</p>
                    </div>
                    <div className="bg-red-50 p-4 rounded-xl text-center">
                      <p className="text-xs font-bold text-red-400 uppercase">Failed</p>
                      <p className="text-2xl font-black text-red-600">{activeCampaign.failed}</p>
                    </div>
                    <div className="bg-orange-50 p-4 rounded-xl text-center">
                      <p className="text-xs font-bold text-orange-400 uppercase">Opens</p>
                      <p className="text-2xl font-black text-orange-600">{activeCampaign.opens || 0}</p>
                    </div>
                    <div className="bg-purple-50 p-4 rounded-xl text-center">
                      <p className="text-xs font-bold text-purple-400 uppercase">Clicks</p>
                      <p className="text-2xl font-black text-purple-600">{activeCampaign.clicks || 0}</p>
                    </div>
                  </div>

                  <div className="w-full bg-gray-100 h-3 rounded-full overflow-hidden mb-6">
                    <div 
                      className="bg-blue-600 h-full transition-all duration-500" 
                      style={{ width: `${(activeCampaign.sent / activeCampaign.total) * 100}%` }}
                    ></div>
                  </div>

                  <div className="bg-gray-900 rounded-xl p-4 h-32 overflow-y-auto font-mono text-[10px] text-green-400">
                    {activeCampaign.logs.slice().reverse().map((log, i) => (
                      <div key={i} className="mb-1 opacity-80">{`> ${log}`}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Campaign History */}
              {campaignHistory.length > 0 && (
                <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
                      <Clock className="text-blue-600" size={20} />
                      Campaign History
                    </h3>
                    <button 
                      onClick={() => {
                        if(confirm('Clear all campaign history?')) setCampaignHistory([]);
                      }}
                      className="text-xs text-red-500 hover:underline flex items-center gap-1"
                    >
                      <Trash2 size={12} /> Clear History
                    </button>
                  </div>
                  <div className="space-y-3">
                    {campaignHistory.map(campaign => (
                      <div key={campaign.id} className="flex items-center justify-between p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-all">
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-bold text-gray-800">{campaign.name}</p>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                              campaign.status === 'completed' ? 'bg-green-100 text-green-600' : 
                              campaign.status === 'running' ? 'bg-blue-100 text-blue-600' : 
                              'bg-gray-100 text-gray-600'
                            }`}>
                              {campaign.status}
                            </span>
                          </div>
                          <div className="flex items-center gap-4 mt-1 text-xs text-gray-400">
                            <span>{new Date(campaign.startTime).toLocaleString()}</span>
                            <span>{campaign.sent}/{campaign.total} Sent</span>
                            {campaign.opens !== undefined && <span>{campaign.opens} Opens</span>}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => setActiveCampaign(campaign)}
                            className="p-2 hover:bg-blue-50 text-blue-600 rounded-lg transition-colors"
                            title="View Details"
                          >
                            <Eye size={18} />
                          </button>
                          <button 
                            onClick={() => handleFollowUp(campaign)}
                            className="p-2 hover:bg-green-50 text-green-600 rounded-lg transition-colors"
                            title="Follow-up (Reply)"
                          >
                            <Plus size={18} />
                          </button>
                          <button 
                            onClick={() => setCampaignHistory(prev => prev.filter(c => c.id !== campaign.id))}
                            className="p-2 hover:bg-red-50 text-red-600 rounded-lg transition-colors"
                            title="Delete Record"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 1: Account & Template */}
              <div className="grid grid-cols-2 gap-6">
                <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm">
                  <label className="block text-sm font-semibold text-gray-700 mb-3">1. Select Sending Account</label>
                  <select 
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    value={selectedAccount}
                    onChange={(e) => setSelectedAccount(e.target.value)}
                  >
                    <option value="">Choose an account...</option>
                    {accounts.map(acc => (
                      <option key={acc.id} value={acc.id}>{acc.email}</option>
                    ))}
                  </select>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm">
                  <label className="block text-sm font-semibold text-gray-700 mb-3">2. Select Email Template</label>
                  <select 
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                    value={selectedTemplate}
                    onChange={(e) => setSelectedTemplate(e.target.value)}
                  >
                    <option value="">Choose a template...</option>
                    {templates.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Step 2: CSV Upload */}
              <div className="bg-white p-8 rounded-2xl border border-gray-200 shadow-sm">
                <label className="block text-sm font-semibold text-gray-700 mb-4">3. Upload Contact CSV</label>
                <div 
                  {...getRootProps()} 
                  className={`border-2 border-dashed rounded-2xl p-12 text-center transition-all cursor-pointer ${
                    isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-400'
                  }`}
                >
                  <input {...getInputProps()} />
                  <div className="flex flex-col items-center gap-4">
                    <div className="bg-blue-50 p-4 rounded-full">
                      <Upload className="text-blue-600" size={32} />
                    </div>
                    <div>
                      <p className="text-lg font-medium text-gray-800">Drop your CSV file here</p>
                      <p className="text-sm text-gray-500 mt-1">Make sure it includes 'email' and 'name' columns</p>
                    </div>
                  </div>
                </div>

                {contacts.length > 0 && (
                  <div className="mt-8">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-semibold flex items-center gap-2">
                        <Users size={18} className="text-blue-600" />
                        Contacts Preview ({contacts.length})
                      </h3>
                      <button onClick={() => setContacts([])} className="text-xs text-red-500 hover:underline flex items-center gap-1">
                        <Trash2 size={12} /> Clear List
                      </button>
                    </div>
                    <div className="overflow-hidden border border-gray-100 rounded-xl">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-gray-50 text-gray-500 uppercase text-xs font-bold">
                          <tr>
                            <th className="px-4 py-3">Name</th>
                            <th className="px-4 py-3">Email</th>
                            <th className="px-4 py-3">Timezone</th>
                            <th className="px-4 py-3">Local Time (Scheduled)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {contacts.slice(0, 5).map((contact, i) => (
                            <tr key={i} className="hover:bg-gray-50">
                              <td className="px-4 py-3 font-medium">{contact.name}</td>
                              <td className="px-4 py-3 text-gray-600">{contact.email}</td>
                              <td className="px-4 py-3 text-xs font-mono text-gray-400">{contact.timezone || 'UTC'}</td>
                              <td className="px-4 py-3 text-xs text-blue-600 font-medium">
                                {formatInTimeZone(new Date(), contact.timezone || 'UTC', 'yyyy-MM-dd HH:mm')}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {contacts.length > 5 && (
                        <div className="p-3 text-center bg-gray-50 text-xs text-gray-400">
                          And {contacts.length - 5} more contacts...
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'templates' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {templates.map(template => (
                <div key={template.id} className="bg-white p-6 rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow group">
                  <div className="flex justify-between items-start mb-4">
                    <div className="bg-blue-50 p-2 rounded-lg">
                      <FileText className="text-blue-600" size={20} />
                    </div>
                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={() => handleEditTemplate(template)}
                        className="p-2 hover:bg-gray-100 rounded-lg text-gray-400"
                      >
                        <Code size={16} />
                      </button>
                      <button 
                        onClick={() => {
                          setEditingTemplate(template);
                          setIsPreviewOpen(true);
                        }}
                        className="p-2 hover:bg-gray-100 rounded-lg text-gray-400"
                      >
                        <Eye size={16} />
                      </button>
                      <button 
                        onClick={() => handleDeleteTemplate(template.id)}
                        className="p-2 hover:bg-red-50 rounded-lg text-red-400"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  <h3 className="font-bold text-gray-800 mb-1">{template.name}</h3>
                  <p className="text-sm text-gray-500 mb-4 line-clamp-1">Subject: {template.subject}</p>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${template.isHtml ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-600'}`}>
                      {template.isHtml ? 'HTML' : 'Text'}
                    </span>
                  </div>
                </div>
              ))}
              <button 
                onClick={() => {
                  setEditingTemplate(null);
                  setTemplateForm({ name: '', subject: '', content: '', isHtml: true });
                  setShowTemplateEditor(true);
                }}
                className="border-2 border-dashed border-gray-200 rounded-2xl p-6 flex flex-col items-center justify-center gap-3 text-gray-400 hover:border-blue-400 hover:text-blue-500 transition-all"
              >
                <Plus size={32} />
                <span className="text-sm font-medium">Create New Template</span>
              </button>
            </div>
          )}

          {activeTab === 'accounts' && (
            <div className="space-y-6">
              <div className="bg-white p-8 rounded-2xl border border-gray-200 shadow-sm">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h3 className="text-lg font-bold text-gray-800">Connected Accounts</h3>
                    <p className="text-sm text-gray-500">Manage your Outlook accounts for sending emails</p>
                  </div>
                  <div className="flex gap-3">
                    <button 
                      onClick={() => setShowManualSetup(true)}
                      className="bg-gray-100 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-gray-200 transition-colors"
                    >
                      <Settings size={18} /> Manual Setup (21Vianet)
                    </button>
                    <button 
                      onClick={handleConnect}
                      disabled={isConnecting}
                      className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {isConnecting ? <Clock className="animate-spin" size={18} /> : <Plus size={18} />}
                      {isConnecting ? 'Connecting...' : 'Add via OAuth'}
                    </button>
                  </div>
                </div>
                
                <div className="space-y-4">
                  {accounts.map(acc => (
                    <div key={acc.id} className="flex items-center justify-between p-4 border border-gray-100 rounded-xl hover:bg-gray-50 transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="bg-blue-50 p-3 rounded-full">
                          <Mail className="text-blue-600" size={24} />
                        </div>
                        <div>
                          <p className="font-bold text-gray-800">{acc.email}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                            <span className="text-xs text-gray-500">
                              {acc.provider === 'smtp' ? `Manual: ${acc.config?.smtpHost}` : 'Connected via Microsoft OAuth'}
                            </span>
                          </div>
                        </div>
                      </div>
                      <button 
                        onClick={() => setAccounts(prev => prev.filter(a => a.id !== acc.id))}
                        className="text-red-500 hover:bg-red-50 px-3 py-1.5 rounded-lg text-xs font-medium"
                      >
                        Disconnect
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Sending Settings Modal */}
      {showSendingSettings && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center shrink-0">
              <h3 className="text-xl font-bold">Campaign Settings</h3>
              <button onClick={() => setShowSendingSettings(false)} className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-full transition-colors">
                <Trash2 size={20} />
              </button>
            </div>
            <div className="p-6 space-y-6 overflow-y-auto flex-1 custom-scrollbar">
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-2">Campaign Name</label>
                <input 
                  type="text" 
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g. S40 Special Issue Follow-up"
                  value={campaignName}
                  onChange={e => setCampaignName(e.target.value)}
                />
              </div>

              <div className="bg-blue-50/50 p-4 rounded-xl border border-blue-100 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold text-blue-800">Schedule Campaign</p>
                    <p className="text-[10px] text-blue-600">Send at a specific time in a specific timezone.</p>
                  </div>
                  <button 
                    onClick={() => setSendingSettings({...sendingSettings, isScheduled: !sendingSettings.isScheduled})}
                    className={`w-12 h-6 rounded-full transition-colors relative ${sendingSettings.isScheduled ? 'bg-blue-600' : 'bg-gray-300'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sendingSettings.isScheduled ? 'left-7' : 'left-1'}`}></div>
                  </button>
                </div>

                {sendingSettings.isScheduled && (
                  <div className="grid grid-cols-1 gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
                    <div>
                      <label className="block text-[10px] font-bold text-blue-400 uppercase mb-1">Send Time</label>
                      <input 
                        type="datetime-local" 
                        className="w-full bg-white border border-blue-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                        value={sendingSettings.scheduledTime}
                        onChange={e => setSendingSettings({...sendingSettings, scheduledTime: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-blue-400 uppercase mb-1">Timezone</label>
                      <select 
                        className="w-full bg-white border border-blue-200 rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                        value={sendingSettings.timezone}
                        onChange={e => setSendingSettings({...sendingSettings, timezone: e.target.value})}
                      >
                        {Intl.supportedValuesOf('timeZone').map(tz => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-4 pt-2">
                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Speed & Throttling</h4>
                
                <div>
                  <div className="flex justify-between mb-2">
                    <label className="text-xs font-bold text-gray-600">Emails Per Minute</label>
                    <span className="text-sm font-bold text-blue-600">{sendingSettings.maxPerMin} / min</span>
                  </div>
                  <input 
                    type="range" 
                    min="1" 
                    max="30" 
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                    value={sendingSettings.maxPerMin}
                    onChange={e => setSendingSettings({...sendingSettings, maxPerMin: parseInt(e.target.value)})}
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Batch Size</label>
                    <input 
                      type="number" 
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none"
                      value={sendingSettings.batchSize}
                      onChange={e => setSendingSettings({...sendingSettings, batchSize: parseInt(e.target.value)})}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-gray-400 uppercase mb-1">Cool-down (min)</label>
                    <input 
                      type="number" 
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none"
                      value={sendingSettings.batchCooling}
                      onChange={e => setSendingSettings({...sendingSettings, batchCooling: parseInt(e.target.value)})}
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-4 pt-2">
                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Advanced Features</h4>
                
                <div className="flex items-center justify-between p-4 bg-blue-50/50 rounded-xl border border-blue-100">
                  <div>
                    <p className="text-sm font-bold text-blue-800">Human Simulation</p>
                    <p className="text-[10px] text-blue-600">Randomizes intervals to avoid filters.</p>
                  </div>
                  <button 
                    onClick={() => setSendingSettings({...sendingSettings, useJitter: !sendingSettings.useJitter})}
                    className={`w-12 h-6 rounded-full transition-colors relative ${sendingSettings.useJitter ? 'bg-blue-600' : 'bg-gray-300'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sendingSettings.useJitter ? 'left-7' : 'left-1'}`}></div>
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
                    <div>
                      <p className="text-sm font-bold text-gray-800">Open Tracking</p>
                      <p className="text-[10px] text-gray-400">Track when emails are opened</p>
                    </div>
                    <button 
                      onClick={() => setSendingSettings({...sendingSettings, enableOpenTracking: !sendingSettings.enableOpenTracking})}
                      className={`w-12 h-6 rounded-full transition-colors relative ${sendingSettings.enableOpenTracking ? 'bg-blue-600' : 'bg-gray-300'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sendingSettings.enableOpenTracking ? 'left-7' : 'left-1'}`}></div>
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
                    <div>
                      <p className="text-sm font-bold text-gray-800">Click Tracking</p>
                      <p className="text-[10px] text-gray-400">Track link clicks in content</p>
                    </div>
                    <button 
                      onClick={() => setSendingSettings({...sendingSettings, enableClickTracking: !sendingSettings.enableClickTracking})}
                      className={`w-12 h-6 rounded-full transition-colors relative ${sendingSettings.enableClickTracking ? 'bg-blue-600' : 'bg-gray-300'}`}
                    >
                      <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${sendingSettings.enableClickTracking ? 'left-7' : 'left-1'}`}></div>
                    </button>
                  </div>
                </div>
              </div>

              <div className="bg-amber-50 p-4 rounded-xl border border-amber-100">
                <p className="text-[10px] text-amber-700 leading-relaxed">
                  <strong>Deliverability Tip:</strong> Slower sending speeds and human simulation significantly improve your inbox placement.
                </p>
              </div>
            </div>
            <div className="p-6 border-t border-gray-100 flex gap-3 bg-gray-50 shrink-0">
              <button 
                onClick={() => setShowSendingSettings(false)}
                className="flex-1 px-6 py-3 rounded-xl text-sm font-bold text-gray-500 hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleSend}
                className="flex-1 bg-blue-600 text-white px-6 py-3 rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 active:scale-[0.98]"
              >
                {sendingSettings.isScheduled ? 'Schedule Campaign' : 'Launch Now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Setup Modal */}
      {showManualSetup && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-bold">Manual Server Setup</h3>
              <button onClick={() => setShowManualSetup(false)} className="text-gray-400 hover:text-gray-600">
                <Trash2 size={20} />
              </button>
            </div>
            <form onSubmit={handleManualConnect} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Email Address</label>
                <input 
                  type="email" 
                  required
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  value={manualConfig.email}
                  onChange={e => setManualConfig({...manualConfig, email: e.target.value})}
                  placeholder="user@outlook.cn"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Password / App Password</label>
                <input 
                  type="password" 
                  required
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  value={manualConfig.password}
                  onChange={e => setManualConfig({...manualConfig, password: e.target.value})}
                />
                <p className="text-[10px] text-gray-400 mt-1">
                  * If you have MFA enabled, please use an <strong>App Password</strong>.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">SMTP Server</label>
                  <input 
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    value={manualConfig.smtpHost}
                    onChange={e => setManualConfig({...manualConfig, smtpHost: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">SMTP Port</label>
                  <input 
                    type="number"
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    value={manualConfig.smtpPort || ''}
                    onChange={e => setManualConfig({...manualConfig, smtpPort: e.target.value ? parseInt(e.target.value) : 0})}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">IMAP Server</label>
                  <input 
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    value={manualConfig.imapHost}
                    onChange={e => setManualConfig({...manualConfig, imapHost: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">IMAP Port</label>
                  <input 
                    type="number"
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    value={manualConfig.imapPort || ''}
                    onChange={e => setManualConfig({...manualConfig, imapPort: e.target.value ? parseInt(e.target.value) : 0})}
                  />
                </div>
              </div>
              <div className="pt-4">
                <button 
                  type="submit"
                  disabled={isConnecting}
                  className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isConnecting ? <Clock className="animate-spin" size={20} /> : <CheckCircle2 size={20} />}
                  {isConnecting ? 'Verifying...' : 'Verify & Save Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Template Editor Modal */}
      {showTemplateEditor && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h3 className="text-xl font-bold">{editingTemplate ? 'Edit Template' : 'Create New Template'}</h3>
              <button 
                onClick={() => setShowTemplateEditor(false)} 
                className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-100 rounded-full transition-colors"
              >
                <Trash2 size={20} />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 space-y-6">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Template Name</label>
                  <input 
                    type="text" 
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    value={templateForm.name}
                    onChange={e => setTemplateForm({...templateForm, name: e.target.value})}
                    placeholder="e.g., Summer Promotion"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1">Email Subject</label>
                  <input 
                    type="text" 
                    className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    value={templateForm.subject}
                    onChange={e => setTemplateForm({...templateForm, subject: e.target.value})}
                    placeholder="e.g., Special offer for {{name}}!"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-bold text-gray-400 uppercase">Email Content (HTML Supported)</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Format:</span>
                    <button 
                      onClick={() => setTemplateForm({...templateForm, isHtml: !templateForm.isHtml})}
                      className={`text-[10px] font-bold uppercase px-2 py-1 rounded-md transition-colors ${templateForm.isHtml ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-600'}`}
                    >
                      {templateForm.isHtml ? 'HTML' : 'Plain Text'}
                    </button>
                  </div>
                </div>
                <textarea 
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-500 h-64 resize-none"
                  value={templateForm.content}
                  onChange={e => setTemplateForm({...templateForm, content: e.target.value})}
                  placeholder="Paste your HTML code here..."
                />
                <p className="text-[10px] text-gray-400 mt-2">
                  Use <code>{"{{name}}"}</code>, <code>{"{{email}}"}</code> or any CSV column name as variables.
                </p>
              </div>

              {templateForm.isHtml && templateForm.content && (
                <div className="border border-gray-100 rounded-2xl overflow-hidden">
                  <div className="bg-gray-50 px-4 py-2 border-b border-gray-100 flex items-center gap-2">
                    <Eye size={14} className="text-gray-400" />
                    <span className="text-[10px] font-bold text-gray-400 uppercase">Live Preview</span>
                  </div>
                  <div className="p-4 bg-white min-h-[100px] max-h-[300px] overflow-y-auto">
                    <div dangerouslySetInnerHTML={{ __html: templateForm.content.replace(/{{name}}/g, 'Valued Customer') }} />
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-gray-100 flex justify-end gap-3 bg-gray-50">
              <button 
                onClick={() => setShowTemplateEditor(false)}
                className="px-6 py-2.5 rounded-xl text-sm font-bold text-gray-500 hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleSaveTemplate}
                className="bg-blue-600 text-white px-8 py-2.5 rounded-xl text-sm font-bold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-200"
              >
                Save Template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full Preview Modal */}
      {isPreviewOpen && editingTemplate && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-8">
          <div className="bg-white rounded-3xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-full">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
              <div>
                <h3 className="text-lg font-bold text-gray-800">Preview: {editingTemplate.name}</h3>
                <p className="text-sm text-gray-500">Subject: {editingTemplate.subject.replace(/{{name}}/g, 'Valued Customer')}</p>
              </div>
              <button 
                onClick={() => setIsPreviewOpen(false)} 
                className="text-gray-400 hover:text-gray-600 p-2 hover:bg-gray-200 rounded-full transition-colors"
              >
                <Trash2 size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-8 bg-gray-100">
              <div className="bg-white shadow-sm rounded-xl p-8 min-h-full mx-auto max-w-2xl">
                {editingTemplate.isHtml ? (
                  <div dangerouslySetInnerHTML={{ __html: editingTemplate.content.replace(/{{name}}/g, 'Valued Customer') }} />
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-gray-700">
                    {editingTemplate.content.replace(/{{name}}/g, 'Valued Customer')}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
