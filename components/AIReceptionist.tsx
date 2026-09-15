'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import {
  type ReceptionistSettings,
  type ReceptionistMessage,
  fillGreeting,
  isWithinBusinessHours,
  DEFAULT_RECEPTIONIST_SETTINGS,
} from '@/lib/ai-receptionist';

type AIReceptionistProps = {
  companyName: string;
  companyPhone: string;
  companyEmail: string;
  settings: ReceptionistSettings;
  messages: ReceptionistMessage[];
  onChangeSettings: (s: ReceptionistSettings) => void;
  onChangeMessages: (m: ReceptionistMessage[]) => void;
  onSave: (s: ReceptionistSettings, m: ReceptionistMessage[]) => void | Promise<void>;
  onBookAppointment?: (opts: {
    summary: string;
    callerName: string;
    callerPhone: string;
    whenLabel: string;
  }) => void;
  getAccessToken: () => Promise<string | null>;
  saving?: boolean;
  onBack: () => void;
  /** Keep Billing / Profile subscription badge in sync when Stripe status changes */
  onAddonStatusChange?: (active: boolean, billing?: Record<string, unknown> | null) => void;
};

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LANG_OPTS = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'de', label: 'German' },
];

type ChatLine = { role: 'caller' | 'agent'; text: string };

export function AIReceptionist({
  companyName,
  companyPhone,
  companyEmail,
  settings,
  messages,
  onChangeSettings,
  onChangeMessages,
  onSave,
  onBookAppointment,
  getAccessToken,
  saving = false,
  onBack,
  onAddonStatusChange,
}: AIReceptionistProps) {
  const [tab, setTab] = React.useState<'inbox' | 'phone' | 'setup' | 'knowledge' | 'test'>('inbox');
  const [chat, setChat] = React.useState<ChatLine[]>([]);
  const [callerInput, setCallerInput] = React.useState('');
  const [testBusy, setTestBusy] = React.useState(false);
  const [testError, setTestError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<'all' | 'new' | 'urgent'>('all');
  const [linePhone, setLinePhone] = React.useState<string | null>(null);
  const [lineStatus, setLineStatus] = React.useState<string>('none');
  const [lineBusy, setLineBusy] = React.useState(false);
  const [lineError, setLineError] = React.useState<string | null>(null);
  const [areaCode, setAreaCode] = React.useState('');
  const [transferNumber, setTransferNumber] = React.useState(companyPhone || '');
  const [addonActive, setAddonActive] = React.useState(false);
  const [addonAmountDisplay, setAddonAmountDisplay] = React.useState('$49.99');
  const [publicBusinessNumber, setPublicBusinessNumber] = React.useState(companyPhone || '');
  const [copiedForward, setCopiedForward] = React.useState(false);

  const inHours = isWithinBusinessHours(settings);
  const activeGreeting = fillGreeting(
    inHours ? settings.greeting : settings.afterHoursGreeting,
    companyName
  );

  const refreshLine = React.useCallback(async () => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch('/api/receptionist', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setLinePhone(json.phoneNumber || json.config?.phoneNumber || null);
      setLineStatus(String(json.status || json.config?.status || 'none'));
      const active = Boolean(json.addonActive || json.subscribed);
      setAddonActive(active);
      if (json.addonAmountDisplay) setAddonAmountDisplay(String(json.addonAmountDisplay));
      if (json.config?.transferNumber) setTransferNumber(String(json.config.transferNumber));
      if (json.config?.publicBusinessNumber) {
        setPublicBusinessNumber(String(json.config.publicBusinessNumber));
      } else if (companyPhone) {
        setPublicBusinessNumber(companyPhone);
      }
      onAddonStatusChange?.(active, json.billing || null);
    } catch {
      /* ignore */
    }
  }, [getAccessToken, companyPhone, onAddonStatusChange]);

  React.useEffect(() => {
    void refreshLine();
  }, [refreshLine]);

  const autoEnabledRef = React.useRef(false);
  // One-time: if AI line exists but toggle was left Off (default), turn On so calls get AI not "please hold"
  React.useEffect(() => {
    if (autoEnabledRef.current) return;
    if (!linePhone || settings.enabled) return;
    if (!addonActive && lineStatus !== 'active') return;
    autoEnabledRef.current = true;
    const next = { ...settings, enabled: true };
    onChangeSettings(next);
    void onSave(next, messages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linePhone, addonActive, lineStatus, settings.enabled]);

  const refreshSubscriptionStatus = async () => {
    setLineBusy(true);
    setLineError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setLineError('Please log in again.');
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const sessionId = params.get('session_id') || '';
      const res = await fetch('/api/receptionist/sync', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId: sessionId || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLineError(json.error || 'Could not refresh subscription.');
        return;
      }
      const active = Boolean(json.addonActive || json.subscribed);
      setAddonActive(active);
      onAddonStatusChange?.(active, json.billing || null);
      await refreshLine();
      if (!active) {
        setLineError(
          json.message ||
            'Stripe has not marked this subscription active yet. Wait a few seconds and tap Refresh again.'
        );
      } else {
        setLineError(null);
      }
    } catch {
      setLineError('Network error refreshing subscription.');
    } finally {
      setLineBusy(false);
    }
  };

  const startAddonCheckout = async () => {
    setLineBusy(true);
    setLineError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setLineError('Please log in again.');
        return;
      }
      if (
        !confirm(
          `AI Receptionist add-on is ${addonAmountDisplay}/month.\n\nYou’ll confirm payment on the next Stripe screen. After payment, come back here to enable your AI phone line.`
        )
      ) {
        return;
      }
      const res = await fetch('/api/receptionist/checkout', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLineError(json.error || 'Could not start checkout.');
        return;
      }
      if (json.alreadyActive) {
        setAddonActive(true);
        setLineError(null);
        await refreshLine();
        return;
      }
      if (json.url) {
        window.location.href = json.url;
        return;
      }
      setLineError('No checkout URL returned.');
    } catch {
      setLineError('Network error starting checkout.');
    } finally {
      setLineBusy(false);
    }
  };

  const enableLine = async () => {
    setLineBusy(true);
    setLineError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setLineError('Please log in again.');
        return;
      }
      const res = await fetch('/api/receptionist/enable', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ areaCode: areaCode.trim() || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.needsPayment) {
          setAddonActive(false);
          setLineError(
            json.error ||
              `Pay for the add-on (${json.amountDisplay || addonAmountDisplay}/mo) before enabling the phone line.`
          );
          return;
        }
        setLineError(json.error || 'Could not provision AI phone number.');
        return;
      }
      setLinePhone(json.phoneNumber || null);
      setLineStatus(String(json.status || 'active'));
      setAddonActive(true);
      if (json.alreadyProvisioned) {
        setLineError(null);
      }
      onChangeSettings({ ...settings, enabled: true });
      await onSave({ ...settings, enabled: true }, messages);
      await refreshLine();
    } catch {
      setLineError('Network error provisioning number.');
    } finally {
      setLineBusy(false);
    }
  };

  const saveLineSettings = async () => {
    setLineBusy(true);
    setLineError(null);
    try {
      const token = await getAccessToken();
      if (!token) return;
      const res = await fetch('/api/receptionist', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transferNumber,
          publicBusinessNumber,
          branding: { businessName: companyName, greeting: settings.greeting },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLineError(json.error || 'Could not save line settings.');
        return;
      }
      await refreshLine();
    } catch {
      setLineError('Network error saving line settings.');
    } finally {
      setLineBusy(false);
    }
  };

  const copyAiNumber = async () => {
    if (!linePhone) return;
    try {
      await navigator.clipboard.writeText(linePhone);
      setCopiedForward(true);
      window.setTimeout(() => setCopiedForward(false), 2000);
    } catch {
      setLineError(`Copy this number manually: ${linePhone}`);
    }
  };

  const filtered = messages.filter((m) => {
    if (filter === 'new') return m.status === 'new';
    if (filter === 'urgent') return m.urgent && !m.spam;
    return true;
  });

  const newCount = messages.filter((m) => m.status === 'new' && !m.spam).length;
  const urgentCount = messages.filter((m) => m.urgent && m.status !== 'handled').length;

  const patch = (partial: Partial<ReceptionistSettings>) => {
    onChangeSettings({ ...settings, ...partial });
  };

  const save = () => void onSave(settings, messages);

  const startTestCall = () => {
    setChat([{ role: 'agent', text: activeGreeting }]);
    setCallerInput('');
    setTestError(null);
    setTab('test');
  };

  const sendCallerLine = async () => {
    const line = callerInput.trim();
    if (!line || testBusy) return;
    setTestBusy(true);
    setTestError(null);
    const nextChat: ChatLine[] = [...chat, { role: 'caller', text: line }];
    setChat(nextChat);
    setCallerInput('');

    try {
      const token = await getAccessToken();
      if (!token) {
        setTestError('Please log in again to use AI Receptionist.');
        setTestBusy(false);
        return;
      }
      const transcript = nextChat
        .map((c) => `${c.role === 'caller' ? 'Caller' : 'Receptionist'}: ${c.text}`)
        .join('\n');

      const res = await fetch('/api/receptionist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: 'reply',
          company: companyName,
          knowledgeBase: settings.knowledgeBase,
          greeting: activeGreeting,
          languages: settings.languages,
          urgentKeywords: settings.urgentKeywords,
          transcript,
          callerMessage: line,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestError(data.error || 'AI reply failed');
        setTestBusy(false);
        return;
      }
      setChat((prev) => [...prev, { role: 'agent', text: data.reply || '…' }]);
    } catch (e) {
      console.error(e);
      setTestError('Network error talking to receptionist AI.');
    } finally {
      setTestBusy(false);
    }
  };

  const endAndSaveMessage = async () => {
    if (chat.length < 2) {
      setTestError('Have a short conversation first, then end the call.');
      return;
    }
    setTestBusy(true);
    setTestError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setTestError('Please log in again.');
        setTestBusy(false);
        return;
      }
      const transcript = chat
        .map((c) => `${c.role === 'caller' ? 'Caller' : 'Receptionist'}: ${c.text}`)
        .join('\n');

      const res = await fetch('/api/receptionist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: 'summarize',
          company: companyName,
          knowledgeBase: settings.knowledgeBase,
          urgentKeywords: settings.urgentKeywords,
          transcript,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTestError(data.error || 'Could not summarize call');
        setTestBusy(false);
        return;
      }

      const msg: ReceptionistMessage = {
        id: `msg-${Date.now()}`,
        createdAt: new Date().toISOString(),
        callerName: data.callerName || 'Unknown',
        callerPhone: data.callerPhone || '',
        summary: data.summary || '',
        actionItems: data.actionItems || [],
        transcript,
        urgent: !!data.urgent,
        spam: settings.spamScreening ? !!data.spam : false,
        language: data.language || 'en',
        status: 'new',
        source: 'test',
      };
      const nextMessages = [msg, ...messages];
      onChangeMessages(nextMessages);
      await onSave(settings, nextMessages);
      setChat([]);
      setTab('inbox');

      if (data.suggestedAppointment && onBookAppointment && settings.bookAppointments) {
        onBookAppointment({
          summary: data.summary || 'Appointment from AI Receptionist',
          callerName: data.callerName || 'Caller',
          callerPhone: data.callerPhone || '',
          whenLabel: data.suggestedAppointment,
        });
      }
    } catch (e) {
      console.error(e);
      setTestError('Failed to save call summary.');
    } finally {
      setTestBusy(false);
    }
  };

  const setStatus = (id: string, status: ReceptionistMessage['status']) => {
    const next = messages.map((m) => (m.id === id ? { ...m, status } : m));
    onChangeMessages(next);
    void onSave(settings, next);
  };

  const deleteMsg = (id: string) => {
    if (!window.confirm('Delete this message?')) return;
    const next = messages.filter((m) => m.id !== id);
    onChangeMessages(next);
    void onSave(settings, next);
  };

  const toggleDay = (d: number) => {
    const has = settings.businessDays.includes(d);
    patch({
      businessDays: has
        ? settings.businessDays.filter((x) => x !== d)
        : [...settings.businessDays, d].sort(),
    });
  };

  const toggleLang = (code: string) => {
    const has = settings.languages.includes(code);
    patch({
      languages: has
        ? settings.languages.filter((l) => l !== code)
        : [...settings.languages, code],
    });
  };

  return (
    <div className="max-w-4xl mx-auto pb-24">
      <Button variant="outline" onClick={onBack} className="mb-4">
        ← Back
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h2 className="text-3xl font-semibold text-[#1e293b]">
            📞 AI Receptionist{' '}
            <span className="text-xs align-middle font-bold uppercase bg-violet-100 text-violet-800 px-2 py-0.5 rounded-full">
              Paid add-on
            </span>
          </h2>
          <p className="text-sm text-gray-500 mt-1 max-w-xl">
            Keep your existing business number. Forward it to your private Twilio AI line. When this
            receptionist is <strong>On</strong>, AI answers; when <strong>Off</strong>, calls ring your
            phone. Leads land in Inbox and dashboard.
          </p>
          {linePhone && (
            <p className="mt-2 text-sm font-semibold text-emerald-800">
              Your AI line:{' '}
              <a className="underline" href={`tel:${linePhone}`}>
                {linePhone}
              </a>
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <label
              className={`flex items-center gap-2 text-sm font-bold border rounded-full px-4 py-2 cursor-pointer ${
                settings.enabled
                  ? 'bg-emerald-600 text-white border-emerald-700'
                  : 'bg-amber-100 text-amber-950 border-amber-300'
              }`}
            >
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={async (e) => {
                  const on = e.target.checked;
                  const next = { ...settings, enabled: on };
                  onChangeSettings(next);
                  await onSave(next, messages);
                }}
                className="rounded"
              />
              {settings.enabled ? 'AI answering: ON' : 'AI answering: OFF'}
            </label>
            <Button
              className="bg-[#10b981] hover:bg-[#059669] text-white"
              onClick={save}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {!settings.enabled && (
            <p className="text-xs text-amber-800 max-w-xs text-right">
              Off = AI stays silent and the call rings your host/business number (no announcement). Turn{' '}
              <strong>ON</strong> for AI to answer.
            </p>
          )}
        </div>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-[10px] uppercase text-gray-500">Status</div>
            <div className={`text-lg font-bold ${settings.enabled ? 'text-emerald-600' : 'text-gray-400'}`}>
              {settings.enabled ? 'Active' : 'Paused'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-[10px] uppercase text-gray-500">Hours now</div>
            <div className="text-lg font-bold text-[#1e293b]">{inHours ? 'Open' : 'After hours'}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-[10px] uppercase text-gray-500">New messages</div>
            <div className="text-lg font-bold text-sky-600">{newCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <div className="text-[10px] uppercase text-gray-500">Urgent</div>
            <div className="text-lg font-bold text-amber-600">{urgentCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap border-b mb-6 gap-1">
        {(
          [
            ['inbox', 'Inbox'],
            ['phone', 'Phone line'],
            ['setup', 'Setup'],
            ['knowledge', 'Knowledge base'],
            ['test', 'Test call'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-3 text-sm font-semibold ${
              tab === id
                ? 'border-b-2 border-[#10b981] text-[#10b981]'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'inbox' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            {(['all', 'new', 'urgent'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1 text-xs font-semibold border ${
                  filter === f
                    ? 'bg-[#10b981] text-white border-[#10b981]'
                    : 'bg-white text-gray-600 border-gray-200'
                }`}
              >
                {f === 'all' ? 'All' : f === 'new' ? 'New' : 'Urgent'}
              </button>
            ))}
            <Button type="button" size="sm" className="ml-auto bg-[#10b981] text-white" onClick={startTestCall}>
              ▶ Test call
            </Button>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed bg-gray-50 p-10 text-center text-gray-500">
              No messages yet. Run a <strong>Test call</strong> to see how summaries land in your inbox,
              or forward missed calls once phone integration is connected.
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((m) => (
                <div
                  key={m.id}
                  className={`bg-white border rounded-2xl p-4 shadow-sm ${
                    m.urgent ? 'border-amber-400 ring-1 ring-amber-200' : 'border-slate-200'
                  } ${m.spam ? 'opacity-60' : ''}`}
                >
                  <div className="flex flex-wrap justify-between gap-2 mb-2">
                    <div>
                      <div className="font-semibold text-[#1e293b]">
                        {m.callerName}
                        {m.callerPhone ? (
                          <span className="text-sm font-normal text-gray-500 ml-2">{m.callerPhone}</span>
                        ) : null}
                      </div>
                      <div className="text-xs text-gray-400">
                        {new Date(m.createdAt).toLocaleString()} · {m.source}
                        {m.language ? ` · ${m.language}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {m.urgent && (
                        <span className="text-[10px] font-bold uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                          Urgent
                        </span>
                      )}
                      {m.spam && (
                        <span className="text-[10px] font-bold uppercase bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">
                          Spam
                        </span>
                      )}
                      <span className="text-[10px] font-bold uppercase bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                        {m.status}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-gray-800 mb-2">{m.summary}</p>
                  {m.actionItems.length > 0 && (
                    <ul className="text-xs text-gray-600 list-disc pl-5 mb-2">
                      {m.actionItems.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  )}
                  <details className="text-xs text-gray-500 mb-3">
                    <summary className="cursor-pointer font-medium">Transcript</summary>
                    <pre className="mt-2 whitespace-pre-wrap bg-slate-50 p-3 rounded-lg border">
                      {m.transcript}
                    </pre>
                  </details>
                  <div className="flex flex-wrap gap-2">
                    {m.status === 'new' && (
                      <Button type="button" size="sm" variant="outline" onClick={() => setStatus(m.id, 'read')}>
                        Mark read
                      </Button>
                    )}
                    {m.status !== 'handled' && (
                      <Button type="button" size="sm" variant="outline" onClick={() => setStatus(m.id, 'handled')}>
                        Handled
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="outline" className="text-red-600" onClick={() => deleteMsg(m.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'phone' && (
        <div className="space-y-6">
          <Card className="border-emerald-200">
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold text-lg">Your AI phone line</h3>
              <p className="text-sm text-gray-600">
                EstimateAce provisions a Twilio number for your business. Callers dial this line and
                talk with the AI (speech). SMS also lands in your Inbox. Fill Knowledge base before
                going live.
              </p>

              <div className="rounded-xl border border-violet-200 bg-violet-50/80 p-4 text-sm text-violet-950">
                <strong>Paid add-on:</strong> {addonAmountDisplay}/month.
                {addonActive ? (
                  <span className="mt-2 inline-flex items-center rounded-full bg-emerald-600 text-white text-xs font-bold uppercase tracking-wide px-3 py-1">
                    Subscribed
                  </span>
                ) : (
                  <span className="block mt-1 text-amber-900">Not subscribed yet — confirm payment below.</span>
                )}
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    disabled={lineBusy}
                    onClick={() => void refreshSubscriptionStatus()}
                  >
                    {lineBusy ? 'Checking…' : 'Refresh subscription'}
                  </Button>
                </div>
              </div>

              {addonActive ? (
                <div className="rounded-2xl border-2 border-emerald-400 bg-emerald-50 p-5 text-center">
                  <p className="text-lg font-bold text-emerald-900">✓ Subscribed — {addonAmountDisplay}/mo</p>
                  <p className="text-sm text-emerald-800 mt-1">
                    {linePhone
                      ? 'Your AI phone line is ready below. Forward your business number to it.'
                      : 'Payment confirmed. Next: enable your AI phone line (only needed once).'}
                  </p>
                </div>
              ) : (
                <div className="rounded-2xl border-2 border-violet-300 bg-white p-5 space-y-3">
                  <p className="text-sm text-slate-800">
                    Step 1 — Confirm payment for AI Receptionist ({addonAmountDisplay}/mo).
                  </p>
                  <Button
                    type="button"
                    className="w-full bg-violet-700 hover:bg-violet-800 text-white font-bold py-6 text-base"
                    disabled={lineBusy}
                    onClick={() => void startAddonCheckout()}
                  >
                    {lineBusy ? 'Opening Stripe…' : `Confirm & pay ${addonAmountDisplay}/mo`}
                  </Button>
                  <p className="text-xs text-gray-500 text-center">
                    Already paid? Tap <strong>Refresh subscription</strong> above.
                  </p>
                </div>
              )}

              {linePhone ? (
                <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-5 text-center">
                  <div className="text-xs uppercase tracking-wide text-emerald-800 font-semibold">
                    AI line ready · {lineStatus}
                  </div>
                  <div className="text-3xl font-bold text-emerald-950 mt-1 tracking-tight">
                    {linePhone}
                  </div>
                  <p className="text-xs text-emerald-800 mt-2">
                    You only need one AI line. Do not tap Enable again — that can buy extra numbers.
                  </p>
                  <a
                    href={`tel:${linePhone}`}
                    className="inline-block mt-3 text-sm font-semibold text-emerald-800 underline"
                  >
                    Call to test
                  </a>
                </div>
              ) : addonActive ? (
                <div className="rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/50 p-5 space-y-3">
                  <p className="text-sm text-slate-700">
                    Step 2 — Enable your AI line <strong>once</strong>. This buys one Twilio number for
                    your account (not each time you open this page).
                  </p>
                  <div>
                    <label className="block text-sm font-semibold mb-1">Preferred area code (optional)</label>
                    <Input
                      value={areaCode}
                      onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                      placeholder="e.g. 305"
                      className="max-w-[8rem]"
                    />
                  </div>
                  <Button
                    type="button"
                    className="w-full bg-[#10b981] hover:bg-[#059669] text-white font-bold"
                    disabled={lineBusy}
                    onClick={() => void enableLine()}
                  >
                    {lineBusy ? 'Provisioning…' : 'Enable AI receptionist line (one time)'}
                  </Button>
                </div>
              ) : null}

              {lineError && (
                <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
                  {lineError}
                </p>
              )}

              {linePhone && (
                <div className="rounded-2xl border-2 border-sky-300 bg-sky-50 p-5 space-y-3">
                  <h4 className="font-semibold text-sky-950 text-base">
                    Keep advertising one number — forward to AI
                  </h4>
                  <p className="text-sm text-sky-900">
                    Customers keep calling your <strong>existing business number</strong>. You forward
                    that line to your private Twilio AI number. When Receptionist is <strong>On</strong>,
                    AI answers. When it is <strong>Off</strong>, calls ring your transfer/owner phone
                    instead so nothing is dropped.
                  </p>
                  <div>
                    <label className="block text-sm font-semibold mb-1">
                      Your public business number (what customers dial)
                    </label>
                    <Input
                      value={publicBusinessNumber}
                      onChange={(e) => setPublicBusinessNumber(e.target.value)}
                      placeholder={companyPhone || '(555) 123-4567'}
                    />
                  </div>
                  <div className="rounded-xl bg-white border border-sky-200 p-3 text-sm space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-xs uppercase text-gray-500 font-semibold">
                          Forward calls to (private AI line)
                        </div>
                        <div className="font-bold text-lg text-slate-900 tracking-tight">{linePhone}</div>
                      </div>
                      <Button type="button" variant="outline" size="sm" onClick={() => void copyAiNumber()}>
                        {copiedForward ? 'Copied!' : 'Copy AI number'}
                      </Button>
                    </div>
                    <ol className="list-decimal pl-5 text-xs text-slate-700 space-y-1.5 pt-1">
                      <li>Copy the AI number above.</li>
                      <li>
                        On your phone carrier or business line settings, turn on{' '}
                        <strong>call forwarding</strong> to that AI number (always forward, or
                        busy / no-answer only — your choice).
                      </li>
                      <li>
                        Keep showing <strong>{publicBusinessNumber || 'your business number'}</strong> on
                        your website, trucks, and Google Business — do not advertise the Twilio number.
                      </li>
                      <li>
                        Turn AI Receptionist <strong>On</strong> (top of this page) and Save when you want
                        AI to answer forwarded calls.
                      </li>
                    </ol>
                    <p className="text-[11px] text-slate-500">
                      Tip: many US carriers use *72 + AI number to turn forwarding on, and *73 to turn it
                      off — check your carrier if those codes differ.
                    </p>
                  </div>
                </div>
              )}

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-semibold mb-1">
                    Owner / cell for human handoff (and when AI is Off)
                  </label>
                  <Input
                    value={transferNumber}
                    onChange={(e) => setTransferNumber(e.target.value)}
                    placeholder={companyPhone || '(555) 123-4567'}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    When AI is <strong>Off</strong>, calls ring this number (or your public business
                    number) with no AI announcement. Prefer a desk/cell that actually answers. Do not put
                    the Twilio AI number here.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={lineBusy}
                  onClick={() => void saveLineSettings()}
                >
                  Save phone settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'setup' && (
        <div className="space-y-6">
          <Card>
            <CardContent className="p-6 space-y-3">
              <h3 className="font-semibold text-lg">Getting started</h3>
              <ol className="text-sm text-gray-700 list-decimal pl-5 space-y-1">
                <li>
                  <strong>Phone line</strong> → pay add-on → <strong>Enable AI receptionist line</strong>.
                </li>
                <li>
                  Forward your <strong>existing business number</strong> to the private AI line (instructions
                  on Phone line).
                </li>
                <li>Turn AI Receptionist <strong>On</strong> and save.</li>
                <li>Fill knowledge base (services, area, hours).</li>
                <li>Call your business number to test — it should reach the AI when On.</li>
              </ol>
              <div className="rounded-xl bg-slate-50 border p-3 text-sm">
                <div className="font-medium text-gray-700">Public business number</div>
                <div className="text-gray-600">
                  {publicBusinessNumber || companyPhone || 'Add in Phone line / Profile'}
                </div>
                <div className="font-medium text-gray-700 mt-2">Private AI forward-to number</div>
                <div className="text-gray-600">{linePhone || 'Not provisioned yet'}</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold text-lg">Greetings & hours</h3>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Business hours greeting (use {'{company}'})
                </label>
                <Textarea
                  rows={2}
                  value={settings.greeting}
                  onChange={(e) => patch({ greeting: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">After-hours greeting</label>
                <Textarea
                  rows={2}
                  value={settings.afterHoursGreeting}
                  onChange={(e) => patch({ afterHoursGreeting: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Open</label>
                  <Input
                    type="time"
                    value={settings.businessHoursStart}
                    onChange={(e) => patch({ businessHoursStart: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Close</label>
                  <Input
                    type="time"
                    value={settings.businessHoursEnd}
                    onChange={(e) => patch({ businessHoursEnd: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {DAY_LABELS.map((label, d) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleDay(d)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold border ${
                      settings.businessDays.includes(d)
                        ? 'bg-[#10b981] text-white border-[#10b981]'
                        : 'bg-white text-gray-500 border-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Notify phone (SMS)</label>
                  <Input
                    value={settings.notifyPhone}
                    onChange={(e) => patch({ notifyPhone: e.target.value })}
                    placeholder={companyPhone || '+1…'}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Notify email</label>
                  <Input
                    value={settings.notifyEmail}
                    onChange={(e) => patch({ notifyEmail: e.target.value })}
                    placeholder={companyEmail || 'you@company.com'}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.spamScreening}
                    onChange={(e) => patch({ spamScreening: e.target.checked })}
                  />
                  Spam detection / screening
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.bookAppointments}
                    onChange={(e) => patch({ bookAppointments: e.target.checked })}
                  />
                  Offer to schedule appointments
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Languages (multilingual support)
                </label>
                <div className="flex flex-wrap gap-2">
                  {LANG_OPTS.map((l) => (
                    <button
                      key={l.code}
                      type="button"
                      onClick={() => toggleLang(l.code)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold border ${
                        settings.languages.includes(l.code)
                          ? 'bg-sky-600 text-white border-sky-600'
                          : 'bg-white text-gray-500 border-gray-200'
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Urgent keywords (comma-separated)
                </label>
                <Input
                  value={settings.urgentKeywords}
                  onChange={(e) => patch({ urgentKeywords: e.target.value })}
                />
              </div>
              <Button className="bg-[#10b981] text-white" onClick={save} disabled={saving}>
                Save setup
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'knowledge' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6 space-y-4">
              <h3 className="font-semibold text-lg">Knowledge base</h3>
              <p className="text-sm text-gray-600">
                What the receptionist knows about your business — services, pricing ranges, service
                area, brands you install, warranty, parking, deposit policy, etc. You can also paste
                text from your website.
              </p>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Website (optional reference)</label>
                <Input
                  value={settings.websiteUrl}
                  onChange={(e) => patch({ websiteUrl: e.target.value })}
                  placeholder="https://yoursite.com"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Business facts & FAQs</label>
                <Textarea
                  rows={14}
                  value={settings.knowledgeBase}
                  onChange={(e) => patch({ knowledgeBase: e.target.value })}
                  placeholder={`Example:\n- HVAC repair & install, Charlotte metro\n- Service call $89, waived with repair\n- Hours Mon–Fri 8–5, emergency after hours fee\n- We don't do commercial refrigeration\n- Financing available on installs over $3,000`}
                  className="font-mono text-sm"
                />
              </div>
              <Button className="bg-[#10b981] text-white" onClick={save} disabled={saving}>
                Save knowledge base
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'test' && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-6 space-y-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <h3 className="font-semibold text-lg">Test call (human-like AI)</h3>
                  <p className="text-xs text-gray-500">
                    Practice as the caller. The agent uses your greeting + knowledge base. End the call
                    to generate a summary, action items, and urgent/spam flags in your inbox.
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={startTestCall}>
                  Restart
                </Button>
              </div>

              <div className="rounded-xl bg-slate-900 text-slate-100 p-4 min-h-[220px] max-h-[360px] overflow-y-auto space-y-3">
                {chat.length === 0 ? (
                  <p className="text-sm text-slate-400">Tap Restart to begin with your greeting.</p>
                ) : (
                  chat.map((c, i) => (
                    <div
                      key={i}
                      className={`text-sm max-w-[90%] rounded-2xl px-3 py-2 ${
                        c.role === 'caller'
                          ? 'ml-auto bg-emerald-600 text-white'
                          : 'mr-auto bg-slate-700'
                      }`}
                    >
                      <div className="text-[10px] uppercase opacity-70 mb-0.5">
                        {c.role === 'caller' ? 'Caller' : 'Receptionist'}
                      </div>
                      {c.text}
                    </div>
                  ))
                )}
              </div>

              <div className="flex gap-2">
                <Input
                  value={callerInput}
                  onChange={(e) => setCallerInput(e.target.value)}
                  placeholder="Type what the caller says…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void sendCallerLine();
                    }
                  }}
                  disabled={testBusy || chat.length === 0}
                />
                <Button
                  type="button"
                  className="bg-[#10b981] text-white shrink-0"
                  onClick={() => void sendCallerLine()}
                  disabled={testBusy || !callerInput.trim()}
                >
                  Send
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => void endAndSaveMessage()}
                disabled={testBusy || chat.length < 2}
              >
                End call → summary to inbox
              </Button>
              {testError && <p className="text-sm text-amber-700">{testError}</p>}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="text-[10px] text-gray-400 mt-8 leading-snug">
        AI Receptionist is designed for small businesses and contractors: 24/7 coverage, message
        summaries, appointment help, urgent flags, multilingual replies, and natural conversation.
        Live carrier forwarding uses your Twilio/SMS stack when provisioned. Not a replacement for 911.
      </p>
    </div>
  );
}

export { DEFAULT_RECEPTIONIST_SETTINGS };
