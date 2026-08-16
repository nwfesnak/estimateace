'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';

type AddressSuggestion = {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  display: string;
  place_id?: string;
};

export type RecurringPlanRow = {
  id: string;
  serviceName: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  amount: number;
  interval: 'week' | 'month' | 'year';
  description: string;
  status: string;
  lastPaymentAt: string | null;
  clientApprovedAt?: string | null;
  approvalEmailSentAt?: string | null;
};

type Props = {
  getAccessToken: () => Promise<string | null>;
  onBack: () => void;
  /** Optional: return to estimate editor instead of only dashboard */
  onBackToEstimate?: () => void;
  showMessage: (msg: string) => void;
  companyName?: string;
  companyEmail?: string;
  companyPhone?: string;
  companySlogan?: string;
  logoUrl?: string;
};

const emptyForm = {
  serviceName: 'Monthly lawn mowing',
  clientName: '',
  clientEmail: '',
  clientPhone: '',
  address: '',
  city: '',
  state: '',
  zipCode: '',
  amount: '150',
  interval: 'month' as 'week' | 'month' | 'year',
  description: '',
};

function statusBadge(status: string) {
  const s = (status || 'draft').toLowerCase();
  if (s === 'active') return 'bg-emerald-100 text-emerald-800';
  if (s === 'approved') return 'bg-emerald-100 text-emerald-900';
  if (s === 'paused') return 'bg-orange-100 text-orange-900';
  if (s === 'canceled') return 'bg-gray-100 text-gray-600';
  if (s === 'past_due') return 'bg-red-100 text-red-800';
  if (s === 'link_sent') return 'bg-sky-100 text-sky-800';
  return 'bg-amber-100 text-amber-900';
}

function statusLabel(status: string, clientApprovedAt?: string | null) {
  const s = (status || 'draft').toLowerCase();
  if (s === 'active') return 'Active — client subscribed & paying';
  if (s === 'paused') return 'Payments off — can turn back on anytime';
  if (s === 'approved' || clientApprovedAt)
    return clientApprovedAt
      ? `✓ Client approved ${new Date(clientApprovedAt).toLocaleDateString()} — set up card if needed`
      : '✓ Client approved recurring charges';
  if (s === 'canceled') return 'In Archive — canceled (not a paid invoice)';
  if (s === 'past_due') return 'Payment past due';
  if (s === 'link_sent') return 'Email sent — waiting for client to approve';
  return 'Draft — email client for approval';
}

function isPaymentsOff(status: string) {
  return String(status || '').toLowerCase() === 'paused';
}

function isPaymentsActive(status: string) {
  const s = String(status || '').toLowerCase();
  return s !== 'paused' && s !== 'canceled';
}

function isCanceledPlan(status: string) {
  return String(status || '').toLowerCase() === 'canceled';
}

export function RecurringServicesPanel({
  getAccessToken,
  onBack,
  onBackToEstimate,
  showMessage,
  companyName,
  companyEmail,
  companyPhone,
  companySlogan,
  logoUrl,
}: Props) {
  const [plans, setPlans] = useState<RecurringPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  /** When set, the form is editing this plan id instead of creating */
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [loadingAddressSuggestions, setLoadingAddressSuggestions] = useState(false);
  const addressSuggestAbortRef = useRef<AbortController | null>(null);

  const authHeaders = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) throw new Error('Please log in again');
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }, [getAccessToken]);

  const loadPlans = useCallback(async () => {
    setLoading(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', { headers });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(json.error || 'Could not load recurring services');
        return;
      }
      setPlans(json.plans || []);
    } catch (e: any) {
      showMessage(e?.message || 'Could not load plans');
    } finally {
      setLoading(false);
    }
  }, [authHeaders, showMessage]);

  useEffect(() => {
    void loadPlans();
  }, [loadPlans]);

  // Service address autocomplete (same Places API as estimate/invoice editor)
  useEffect(() => {
    if (!showForm) return;
    const q = form.address.trim();
    if (!q || q.length < 2) {
      setAddressSuggestions([]);
      setLoadingAddressSuggestions(false);
      return;
    }

    const timer = setTimeout(async () => {
      addressSuggestAbortRef.current?.abort();
      const controller = new AbortController();
      addressSuggestAbortRef.current = controller;
      setLoadingAddressSuggestions(true);
      try {
        const params = new URLSearchParams({ q });
        if (form.city.trim()) params.set('city', form.city.trim());
        if (form.state.trim()) params.set('state', form.state.trim());
        if (form.zipCode.trim()) params.set('zip', form.zipCode.trim());
        const res = await fetch(`/api/address-autocomplete?${params.toString()}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) {
          if (!controller.signal.aborted) setAddressSuggestions([]);
          return;
        }
        const data = await res.json().catch(() => []);
        if (!controller.signal.aborted) {
          setAddressSuggestions(Array.isArray(data) ? data.slice(0, 8) : []);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        if (!controller.signal.aborted) setAddressSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setLoadingAddressSuggestions(false);
      }
    }, 300);

    return () => {
      clearTimeout(timer);
      addressSuggestAbortRef.current?.abort();
    };
  }, [form.address, form.city, form.state, form.zipCode, showForm]);

  const applyAddressSuggestion = async (sugg: AddressSuggestion) => {
    setShowAddressSuggestions(false);
    setAddressSuggestions([]);
    if (sugg.place_id) {
      try {
        const res = await fetch(
          `/api/address-autocomplete?place_id=${encodeURIComponent(sugg.place_id)}`
        );
        if (res.ok) {
          const details = await res.json();
          setForm((f) => ({
            ...f,
            address: details.address || sugg.address || sugg.display || '',
            city: details.city || sugg.city || f.city,
            state: details.state || sugg.state || f.state,
            zipCode: details.zipCode || sugg.zipCode || f.zipCode,
          }));
          return;
        }
      } catch {
        /* fall through */
      }
    }
    setForm((f) => ({
      ...f,
      address: sugg.address || sugg.display || '',
      city: sugg.city || f.city,
      state: sugg.state || f.state,
      zipCode: sugg.zipCode || f.zipCode,
    }));
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingPlanId(null);
    setForm(emptyForm);
    setAddressSuggestions([]);
    setShowAddressSuggestions(false);
  };

  const startEditPlan = (p: RecurringPlanRow) => {
    setEditingPlanId(p.id);
    setForm({
      serviceName: p.serviceName || '',
      clientName: p.clientName || '',
      clientEmail: p.clientEmail || '',
      clientPhone: p.clientPhone || '',
      address: p.address || '',
      city: p.city || '',
      state: p.state || '',
      zipCode: p.zipCode || '',
      amount: String(p.amount ?? ''),
      interval: (p.interval === 'week' || p.interval === 'year' ? p.interval : 'month') as
        | 'week'
        | 'month'
        | 'year',
      description: p.description || '',
    });
    setShowForm(true);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const savePlanEdits = async () => {
    if (!editingPlanId) return;
    const snapshot = {
      serviceName: String(form.serviceName || '').trim(),
      clientName: String(form.clientName || '').trim(),
      clientEmail: String(form.clientEmail || '')
        .trim()
        .replace(/\s+/g, '')
        .toLowerCase(),
      clientPhone: String(form.clientPhone || '').trim(),
      address: String(form.address || '').trim(),
      city: String(form.city || '').trim(),
      state: String(form.state || '').trim(),
      zipCode: String(form.zipCode || '').trim(),
      amount: parseFloat(form.amount) || 0,
      interval: form.interval,
      description: String(form.description || '').trim(),
    };

    if (!snapshot.serviceName) {
      showMessage('Enter a service name.');
      return;
    }
    if (snapshot.clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snapshot.clientEmail)) {
      showMessage('Client email looks invalid (example: client@gmail.com).');
      return;
    }
    if (snapshot.amount < 0.5) {
      showMessage('Amount must be at least $0.50.');
      return;
    }

    setSaving(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          id: editingPlanId,
          planId: editingPlanId,
          action: 'update',
          ...snapshot,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(
          `❌ Could not save: ${json.error || `HTTP ${res.status}`}. Try again or refresh the page.`
        );
        return;
      }
      // Optimistic UI update so the list reflects edits immediately
      setPlans((prev) =>
        prev.map((p) =>
          p.id === editingPlanId
            ? {
                ...p,
                serviceName: snapshot.serviceName,
                clientName: snapshot.clientName,
                clientEmail: snapshot.clientEmail,
                clientPhone: snapshot.clientPhone,
                address: snapshot.address,
                city: snapshot.city,
                state: snapshot.state,
                zipCode: snapshot.zipCode,
                amount: snapshot.amount,
                interval: snapshot.interval,
                description: snapshot.description,
              }
            : p
        )
      );
      showMessage('✅ Plan updated.');
      closeForm();
      await loadPlans();
    } catch (e: any) {
      showMessage(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const createPlan = async (andEmail: boolean) => {
    // Snapshot form before any state clear / await so email is never lost
    const snapshot = {
      ...form,
      clientEmail: String(form.clientEmail || '')
        .trim()
        .replace(/\s+/g, '')
        .toLowerCase(),
      amount: parseFloat(form.amount) || 0,
    };

    if (!snapshot.serviceName.trim()) {
      showMessage('Enter a service name (e.g. Monthly lawn mowing).');
      return;
    }
    if (andEmail || snapshot.clientEmail) {
      if (!snapshot.clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snapshot.clientEmail)) {
        showMessage('Enter a valid client email (example: client@gmail.com) before sending approval.');
        return;
      }
    }

    setSaving(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...snapshot,
          companyName,
          companyEmail,
          companyPhone,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(json.error || 'Could not create plan');
        return;
      }
      const planId = json.plan?.id;
      if (andEmail && planId) {
        const sendRes = await fetch('/api/recurring/send', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            planId,
            companyName,
            companyEmail,
            companyPhone,
            clientEmail: snapshot.clientEmail,
            clientPhone: snapshot.clientPhone,
          }),
        });
        const sendJson = await sendRes.json().catch(() => ({}));
        closeForm();
        await loadPlans();
        if (!sendRes.ok) {
          const link = String(sendJson.clientLink || json.clientLink || '').trim();
          if (link && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            try {
              await navigator.clipboard.writeText(link);
            } catch {
              /* ignore */
            }
          }
          showMessage(
            `Plan created, but send failed: ${sendJson.error || 'check email/SMS setup'}.${
              link ? ' Client approval link copied — paste it to your client.' : ' Use Copy client link.'
            }`
          );
          return;
        }
        const bits: string[] = [];
        if (sendJson.emailSent) bits.push(`email ${sendJson.to || snapshot.clientEmail}`);
        if (sendJson.smsSent) bits.push(`SMS ${sendJson.smsTo || snapshot.clientPhone}`);
        showMessage(
          `✅ Plan created & approval sent${bits.length ? ` (${bits.join(' · ')})` : ''}.`
        );
        return;
      }
      closeForm();
      await loadPlans();
      showMessage(
        snapshot.clientEmail
          ? '✅ Plan created. Use “Email client for approval” when ready.'
          : '✅ Plan created. Add a client email on the plan, then email for approval.'
      );
    } catch (e: any) {
      showMessage(e?.message || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const emailClientApproval = async (
    planId: string,
    clientEmail: string,
    clientPhone?: string
  ) => {
    let email = String(clientEmail || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/^mailto:/i, '')
      .toLowerCase();
    let phone = String(clientPhone || '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const typed =
        typeof window !== 'undefined'
          ? window.prompt(
              'Client email is missing or invalid on this plan.\n\nEnter the client email to send approval (or leave blank if sending SMS only):',
              email || ''
            )
          : null;
      if (typed != null) {
        email = String(typed || '')
          .trim()
          .replace(/\s+/g, '')
          .replace(/^mailto:/i, '')
          .toLowerCase();
      }
    }

    if (!phone || phone.replace(/\D/g, '').length < 10) {
      // keep phone from plan; optional prompt only if no email either
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const typedPhone =
          typeof window !== 'undefined'
            ? window.prompt('Enter client phone for SMS approval link (10+ digits):', phone || '')
            : null;
        if (typedPhone != null) phone = String(typedPhone || '').trim();
      }
    }

    const hasEmail = !!(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    const hasPhone = !!(phone && phone.replace(/\D/g, '').length >= 10);
    if (!hasEmail && !hasPhone) {
      showMessage('Add a client email and/or phone on the plan (Edit plan), then send again.');
      return;
    }

    setBusyId(planId);
    try {
      const headers = await authHeaders();
      // Persist contact before send
      await fetch('/api/recurring/plans', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          id: planId,
          ...(hasEmail ? { clientEmail: email } : {}),
          ...(hasPhone ? { clientPhone: phone } : {}),
        }),
      });

      const res = await fetch('/api/recurring/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          planId,
          companyName,
          companyEmail,
          companyPhone,
          clientEmail: hasEmail ? email : undefined,
          clientPhone: hasPhone ? phone : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const link = String(json.clientLink || '').trim();
        if (link && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(link);
          } catch {
            /* ignore */
          }
        }
        showMessage(
          `❌ ${json.error || 'Could not send approval'}${
            link ? ' — Client approval link was copied; paste it to your client.' : ' — Use Copy client link.'
          }`
        );
        await loadPlans();
        return;
      }
      const bits: string[] = [];
      if (json.emailSent) bits.push(`email ${json.to || email}`);
      if (json.smsSent) bits.push(`SMS ${json.smsTo || phone}`);
      if (!json.smsSent && hasPhone) {
        bits.push('SMS not sent (check Twilio setup)');
      }
      showMessage(
        `✅ Approval sent${bits.length ? `: ${bits.join(' · ')}` : ''}. Client can open the link to approve.`
      );
      await loadPlans();
    } catch (e: any) {
      showMessage(e?.message || 'Send failed');
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (planId: string) => {
    setBusyId(planId);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/checkout', {
        method: 'POST',
        headers,
        body: JSON.stringify({ planId, linkOnly: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.clientLink) {
        showMessage(json.error || 'Could not get link');
        return;
      }
      await navigator.clipboard.writeText(json.clientLink);
      showMessage('✅ Client link copied. Send it so they can subscribe & pay automatically.');
    } catch (e: any) {
      showMessage(e?.message || 'Copy failed');
    } finally {
      setBusyId(null);
    }
  };

  const setPaymentsEnabled = async (planId: string, on: boolean) => {
    setBusyId(planId);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id: planId, action: on ? 'resume' : 'pause' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(json.error || (on ? 'Could not turn payments on' : 'Could not turn payments off'));
        return;
      }
      showMessage(
        on
          ? '✅ Payments turned back on for this plan.'
          : '✅ Payments turned off. Plan stays under Payments off — turn back on anytime.'
      );
      await loadPlans();
    } catch (e: any) {
      showMessage(e?.message || 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  const cancelPlan = async (planId: string) => {
    if (
      !window.confirm(
        'Cancel this recurring service permanently?\n\nThe client will no longer be charged. The plan moves to Recurring → Archive (also under Reports → Recurring → Archive). It is not a paid invoice.\n\nTip: use “Turn off payments” if you only want to pause billing.'
      )
    ) {
      return;
    }
    setBusyId(planId);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id: planId, action: 'cancel' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(json.error || 'Could not cancel');
        return;
      }
      showMessage(
        json.message ||
          '✅ Plan canceled and moved to Recurring → Archive. EstimateAce software billing is unchanged.'
      );
      await loadPlans();
    } catch (e: any) {
      showMessage(e?.message || 'Cancel failed');
    } finally {
      setBusyId(null);
    }
  };

  const restorePlan = async (planId: string) => {
    if (
      !window.confirm(
        'Restore this plan from Archive?\n\nIt will return as a draft under Active / onboarding so you can re-send approval.'
      )
    ) {
      return;
    }
    setBusyId(planId);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id: planId, action: 'restore' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(json.error || 'Could not restore');
        return;
      }
      showMessage(
        json.message ||
          '✅ Plan restored as a draft. Re-send approval if the client needs to approve again.'
      );
      await loadPlans();
    } catch (e: any) {
      showMessage(e?.message || 'Restore failed');
    } finally {
      setBusyId(null);
    }
  };

  const deleteArchivedPlan = async (planId: string) => {
    if (
      !window.confirm(
        'Permanently delete this archived plan?\n\nThis cannot be undone. The client will not be charged (billing already stopped when canceled).'
      )
    ) {
      return;
    }
    setBusyId(planId);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ id: planId, action: 'delete' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(json.error || 'Could not delete');
        return;
      }
      setPlans((prev) => prev.filter((p) => p.id !== planId));
      showMessage(json.message || '✅ Archived plan deleted.');
      await loadPlans();
    } catch (e: any) {
      showMessage(e?.message || 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto min-w-0">
      {/* Same chrome style as Create Estimate */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <Button variant="outline" onClick={onBack}>
          ← Back to dashboard
        </Button>
        {onBackToEstimate && (
          <Button variant="outline" onClick={onBackToEstimate}>
            ← Back to estimate
          </Button>
        )}
      </div>

      <div className="flex flex-wrap justify-between items-start gap-4 mb-8">
        <div className="flex items-start gap-4 min-w-0">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt=""
              className="w-16 h-16 object-contain border rounded shrink-0"
            />
          ) : null}
          <div className="min-w-0">
            <h1 className="text-3xl sm:text-4xl font-bold text-[#1e293b]">
              {companyName || 'Your company'}
            </h1>
            {companySlogan ? (
              <p className="text-lg text-gray-600">{companySlogan}</p>
            ) : null}
            <p className="text-xl font-semibold text-teal-800 mt-2">🔁 Recurring charges</p>
            <p className="text-sm text-gray-600 mt-1 max-w-xl">
              Create scheduled client billing (mowing, maintenance, etc.) — same workflow as an
              estimate, for auto-charges.
            </p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm text-gray-500">Document type</div>
          <div className="text-2xl font-mono font-bold text-teal-700">RECURRING</div>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
        <strong>Not your EstimateAce plan.</strong> These charges bill <strong>your clients</strong>{' '}
        only. Software billing stays under Profile → Billing.
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <Button
          className="bg-[#10b981] hover:bg-[#059669] text-white"
          onClick={() => {
            if (showForm) {
              closeForm();
            } else {
              setEditingPlanId(null);
              setForm(emptyForm);
              setShowForm(true);
            }
          }}
        >
          {showForm ? 'Close form' : '+ New recurring service'}
        </Button>
        <Button variant="outline" onClick={() => void loadPlans()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {showForm && (
        <Card className="mb-8 border-emerald-200">
          <CardContent className="p-6 space-y-4">
            <h3 className="font-semibold text-lg">
              {editingPlanId ? 'Edit recurring plan' : 'Create a plan (about 1 minute)'}
            </h3>
            <p className="text-sm text-gray-500">
              {editingPlanId
                ? 'Update client info, amount, schedule, or notes. Save when done.'
                : 'Example: “Monthly lawn mowing” · Client: Jane Smith · $150 every month'}
            </p>
            {editingPlanId && (
              <p className="text-xs font-mono text-gray-400">Plan id: {editingPlanId}</p>
            )}

            <div>
              <label className="block text-sm font-semibold mb-1">Service name *</label>
              <Input
                value={form.serviceName}
                onChange={(e) => setForm((f) => ({ ...f, serviceName: e.target.value }))}
                placeholder="Monthly lawn mowing"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-1">Client name</label>
                <Input
                  value={form.clientName}
                  onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value }))}
                  placeholder="Jane Smith"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">Client email *</label>
                <Input
                  type="email"
                  value={form.clientEmail}
                  onChange={(e) => setForm((f) => ({ ...f, clientEmail: e.target.value }))}
                  placeholder="client@gmail.com"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  Required to email approval. Without it, use Copy client link instead.
                </p>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Client phone (optional)</label>
              <Input
                value={form.clientPhone}
                onChange={(e) => setForm((f) => ({ ...f, clientPhone: e.target.value }))}
              />
            </div>
            <div className="relative">
              <label className="block text-sm font-semibold mb-1">Service address</label>
              <Input
                value={form.address}
                onChange={(e) => {
                  setForm((f) => ({ ...f, address: e.target.value }));
                  setShowAddressSuggestions(true);
                }}
                onFocus={() => setShowAddressSuggestions(true)}
                onBlur={() => setTimeout(() => setShowAddressSuggestions(false), 200)}
                placeholder="Street address — include city & state for best results"
                autoComplete="street-address"
              />
              {showAddressSuggestions && (
                <div className="absolute z-[60] mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto text-sm">
                  {loadingAddressSuggestions && (
                    <div className="px-3 py-2 text-xs text-gray-500">Searching addresses…</div>
                  )}
                  {!loadingAddressSuggestions &&
                    addressSuggestions.length === 0 &&
                    form.address.trim().length >= 2 && (
                      <div className="px-3 py-2 text-xs text-gray-500">
                        No matches yet. Try adding the city and state (e.g. 123 Main St, Charlotte NC).
                      </div>
                    )}
                  {addressSuggestions.map((sugg, idx) => (
                    <div
                      key={`${sugg.place_id || sugg.display || sugg.address}-${idx}`}
                      className="px-3 py-2 hover:bg-gray-100 cursor-pointer border-b border-gray-100 last:border-b-0"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        void applyAddressSuggestion(sugg);
                      }}
                    >
                      <div className="font-medium leading-snug">
                        {sugg.display || sugg.address}
                      </div>
                      {sugg.address && sugg.display && sugg.display !== sugg.address && (
                        <div className="text-[11px] text-gray-600 mt-0.5">{sugg.address}</div>
                      )}
                      {(sugg.city || sugg.state || sugg.zipCode) &&
                        !sugg.display?.includes(sugg.city) && (
                          <div className="text-[10px] text-gray-500 mt-0.5">
                            {[sugg.city, sugg.state, sugg.zipCode].filter(Boolean).join(', ')}
                          </div>
                        )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Input
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                placeholder="City"
              />
              <Input
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                placeholder="State"
              />
              <Input
                value={form.zipCode}
                onChange={(e) => setForm((f) => ({ ...f, zipCode: e.target.value }))}
                placeholder="ZIP"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold mb-1">Amount (USD) *</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.5"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1">Bill how often?</label>
                <select
                  className="w-full border rounded-md h-10 px-3"
                  value={form.interval}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      interval: e.target.value as 'week' | 'month' | 'year',
                    }))
                  }
                >
                  <option value="week">Every week</option>
                  <option value="month">Every month</option>
                  <option value="year">Every year</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Notes for client (optional)</label>
              <Textarea
                rows={3}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Includes mowing front and back yard, edging, and blow-off."
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              {editingPlanId ? (
                <>
                  <Button
                    className="flex-1 bg-[#10b981] hover:bg-[#059669] text-white py-6 text-base"
                    disabled={saving}
                    onClick={() => void savePlanEdits()}
                  >
                    {saving ? 'Saving…' : '💾 Save changes'}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 py-6"
                    disabled={saving}
                    onClick={() => closeForm()}
                  >
                    Cancel edit
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    className="flex-1 bg-[#10b981] hover:bg-[#059669] text-white py-6 text-base"
                    disabled={saving}
                    onClick={() => void createPlan(true)}
                  >
                    {saving ? 'Working…' : 'Create & send approval (email + SMS)'}
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 py-6"
                    disabled={saving}
                    onClick={() => void createPlan(false)}
                  >
                    Create only (email later)
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <p className="text-gray-500">Loading plans…</p>
      ) : plans.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-gray-600">
            <div className="text-4xl mb-3">🌱</div>
            <p className="font-semibold text-lg text-gray-800">No recurring services yet</p>
            <p className="mt-2 text-sm max-w-md mx-auto">
              Create one for lawn care, pool service, filter changes, or any service you bill on a
              schedule. Send approval by email and text — the client opens the link to approve.
            </p>
            <Button
              className="mt-6 bg-[#10b981] text-white"
              onClick={() => setShowForm(true)}
            >
              + Create your first plan
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-10">
          {([
            {
              key: 'active',
              title: 'Active / onboarding',
              hint: 'Drafts, awaiting approval, and paying clients.',
              list: plans.filter((p) => isPaymentsActive(p.status)),
            },
            {
              key: 'off',
              title: 'Payments off',
              hint: 'Billing paused — turn payments back on anytime without re-creating the plan.',
              list: plans.filter((p) => isPaymentsOff(p.status)),
            },
            {
              key: 'archive',
              title: 'Archive',
              hint: 'Canceled plans. Restore to draft or delete permanently. These are not paid invoices.',
              list: plans.filter((p) => isCanceledPlan(p.status)),
            },
          ] as const).map((section) => (
            <div key={section.key}>
              <div className="mb-3">
                <h3 className="text-lg font-semibold text-[#1e293b]">{section.title}</h3>
                <p className="text-sm text-gray-500">{section.hint}</p>
              </div>
              {section.list.length === 0 ? (
                <div className="rounded-xl border border-dashed bg-slate-50 p-6 text-sm text-gray-500">
                  No plans in this section.
                </div>
              ) : (
                <div className="space-y-4">
                  {section.list.map((p) => {
                    const canceled = isCanceledPlan(p.status);
                    return (
                    <Card key={p.id} className={`overflow-hidden ${canceled ? 'opacity-95 border-slate-300' : ''}`}>
                      <CardContent className="p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-semibold text-lg text-[#1e293b]">{p.serviceName}</h3>
                              <span
                                className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${statusBadge(
                                  p.status
                                )}`}
                              >
                                {p.status || 'draft'}
                              </span>
                            </div>
                            <p className="text-sm text-gray-600 mt-1">
                              {p.clientName || 'Client'}
                              {p.clientEmail ? ` · ${p.clientEmail}` : ' · ⚠️ no email'}
                              {p.clientPhone ? ` · ${p.clientPhone}` : ' · ⚠️ no phone'}
                            </p>
                            {!canceled && !p.clientEmail && !p.clientPhone && (
                              <p className="text-xs text-amber-700 mt-1">
                                Add email and/or phone with Edit plan so approval can be sent.
                              </p>
                            )}
                            <p className="text-xl font-bold text-emerald-700 mt-2">
                              ${Number(p.amount).toFixed(2)}
                              <span className="text-sm font-semibold text-gray-600">
                                {' '}
                                / {p.interval}
                              </span>
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              {statusLabel(p.status, p.clientApprovedAt)}
                            </p>
                            {p.clientApprovedAt && !canceled && (
                              <p className="text-xs font-semibold text-emerald-700 mt-1">
                                ✓ Client approved on {new Date(p.clientApprovedAt).toLocaleString()}
                              </p>
                            )}
                            {p.approvalEmailSentAt && !p.clientApprovedAt && !canceled && (
                              <p className="text-xs text-sky-700 mt-1">
                                Approval email sent {new Date(p.approvalEmailSentAt).toLocaleString()}
                              </p>
                            )}
                            {(p.address || p.city) && (
                              <p className="text-xs text-gray-500 mt-1">
                                {[p.address, p.city, p.state, p.zipCode].filter(Boolean).join(', ')}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-col gap-2 w-full sm:w-auto">
                            {canceled ? (
                              <>
                                <Button
                                  size="sm"
                                  className="bg-emerald-700 hover:bg-emerald-800 text-white"
                                  disabled={busyId === p.id}
                                  onClick={() => void restorePlan(p.id)}
                                >
                                  ↻ Restore from archive
                                </Button>
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busyId === p.id}
                                  onClick={() => void deleteArchivedPlan(p.id)}
                                >
                                  🗑 Delete permanently
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="border-slate-300"
                                  disabled={busyId === p.id || saving}
                                  onClick={() => startEditPlan(p)}
                                >
                                  ✏️ Edit plan
                                </Button>
                                <Button
                                  size="sm"
                                  className="bg-[#10b981] hover:bg-[#059669] text-white"
                                  disabled={busyId === p.id}
                                  onClick={() =>
                                    void emailClientApproval(p.id, p.clientEmail, p.clientPhone)
                                  }
                                >
                                  📧📱 Send approval (email + SMS)
                                </Button>
                                <Button
                                  size="sm"
                                  className="bg-[#0ea5e9] text-white"
                                  disabled={busyId === p.id}
                                  onClick={() => void copyLink(p.id)}
                                >
                                  📋 Copy client link
                                </Button>
                                {isPaymentsOff(p.status) ? (
                                  <Button
                                    size="sm"
                                    className="bg-emerald-700 hover:bg-emerald-800 text-white"
                                    disabled={busyId === p.id}
                                    onClick={() => void setPaymentsEnabled(p.id, true)}
                                  >
                                    ▶️ Turn payments on
                                  </Button>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="border-orange-300 text-orange-800"
                                    disabled={busyId === p.id}
                                    onClick={() => void setPaymentsEnabled(p.id, false)}
                                  >
                                    ⏸ Turn off payments
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-red-600 border-red-200"
                                  disabled={busyId === p.id}
                                  onClick={() => void cancelPlan(p.id)}
                                >
                                  Cancel → Archive
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-10 rounded-xl border bg-white p-5 text-sm text-gray-600 space-y-2">
        <p className="font-semibold text-gray-900">How it works</p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Create a plan (service, client email + phone, amount, weekly/monthly/yearly).</li>
          <li>
            Tap <strong>Send approval (email + SMS)</strong> — the client gets the approval link by
            email and text (phone on file).
          </li>
          <li>
            When they open the link and approve, you&apos;ll see <strong>✓ Client approved</strong> on
            the plan — and you get an email/SMS (using your company email/phone on the plan).
          </li>
          <li>
            When they finish card / payment setup, the plan becomes <strong>Active</strong> and you get
            another notification.
          </li>
          <li>
            <strong>Turn off payments</strong> pauses billing; <strong>Cancel → Archive</strong> ends
            the plan under Archive (not a paid invoice). From Archive you can restore or delete permanently.
          </li>
          <li>Job invoices stay under Invoices and only move to Paid invoices when marked paid.</li>
        </ol>
        <p className="text-xs text-gray-500 pt-2">
          Email needs Resend (same as estimate send). SMS needs Twilio env vars (TWILIO_ACCOUNT_SID,
          TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER). Notifications go to the company email/phone saved on
          the plan (from your profile when you create it). If SMS is not set up, email still sends and you
          can Copy client link.
        </p>
      </div>
    </div>
  );
}
