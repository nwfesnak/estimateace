'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';

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
  showMessage: (msg: string) => void;
  companyName?: string;
  companyEmail?: string;
  companyPhone?: string;
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
  if (s === 'canceled') return 'bg-gray-100 text-gray-600';
  if (s === 'past_due') return 'bg-red-100 text-red-800';
  if (s === 'link_sent') return 'bg-sky-100 text-sky-800';
  return 'bg-amber-100 text-amber-900';
}

function statusLabel(status: string, clientApprovedAt?: string | null) {
  const s = (status || 'draft').toLowerCase();
  if (s === 'active') return 'Active — client subscribed & paying';
  if (s === 'approved' || clientApprovedAt)
    return clientApprovedAt
      ? `✓ Client approved ${new Date(clientApprovedAt).toLocaleDateString()} — set up card if needed`
      : '✓ Client approved recurring charges';
  if (s === 'canceled') return 'Canceled';
  if (s === 'past_due') return 'Payment past due';
  if (s === 'link_sent') return 'Email sent — waiting for client to approve';
  return 'Draft — email client for approval';
}

export function RecurringServicesPanel({
  getAccessToken,
  onBack,
  showMessage,
  companyName,
  companyEmail,
  companyPhone,
}: Props) {
  const [plans, setPlans] = useState<RecurringPlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const createPlan = async (andEmail: boolean) => {
    setSaving(true);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/plans', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...form,
          amount: parseFloat(form.amount) || 0,
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
      setShowForm(false);
      setForm(emptyForm);
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
          }),
        });
        const sendJson = await sendRes.json().catch(() => ({}));
        await loadPlans();
        if (!sendRes.ok) {
          showMessage(
            `Plan created, but email failed: ${sendJson.error || 'check Resend settings'}. You can retry Email client.`
          );
          return;
        }
        showMessage(
          `✅ Plan created & approval email sent to ${form.clientEmail || 'client'}.`
        );
        return;
      }
      await loadPlans();
      showMessage('✅ Plan created. Use “Email client for approval” when ready.');
    } catch (e: any) {
      showMessage(e?.message || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  const emailClientApproval = async (planId: string, clientEmail: string) => {
    if (!clientEmail?.trim()) {
      showMessage('Add a client email on this plan before sending.');
      return;
    }
    setBusyId(planId);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/send', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          planId,
          companyName,
          companyEmail,
          companyPhone,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        showMessage(json.error || 'Could not send approval email');
        return;
      }
      showMessage(`✅ Approval email sent to ${clientEmail}`);
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

  const openCheckoutForClient = async (planId: string) => {
    setBusyId(planId);
    try {
      const headers = await authHeaders();
      const res = await fetch('/api/recurring/checkout', {
        method: 'POST',
        headers,
        body: JSON.stringify({ planId }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.url) {
        window.open(json.url, '_blank');
        showMessage('Opened Stripe checkout in a new tab (for client to complete).');
        return;
      }
      if (json.clientLink) {
        await navigator.clipboard.writeText(json.clientLink);
        showMessage(
          (json.error ? json.error + ' — ' : '') +
            'Client link copied instead. Share it with your client.'
        );
        return;
      }
      showMessage(json.error || 'Could not start checkout');
    } catch (e: any) {
      showMessage(e?.message || 'Checkout failed');
    } finally {
      setBusyId(null);
    }
  };

  const cancelPlan = async (planId: string) => {
    if (!window.confirm('Cancel this recurring service? The client will no longer be charged.')) {
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
      showMessage('Plan canceled. Your EstimateAce software subscription is unchanged.');
      await loadPlans();
    } catch (e: any) {
      showMessage(e?.message || 'Cancel failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <Button variant="outline" onClick={onBack} className="mb-6">
        ← Back to dashboard
      </Button>

      <div className="mb-6">
        <h2 className="text-3xl font-semibold text-[#1e293b]">🔁 Recurring client charges</h2>
        <p className="text-gray-600 mt-2 max-w-2xl">
          Bill <strong>your clients</strong> automatically for services like monthly mowing, pest
          control, or maintenance.
        </p>
        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950">
          <strong>Not your EstimateAce plan.</strong> Monthly/yearly software billing stays under
          Profile → Billing. These plans only charge the customer for the work you do.
        </div>
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <Button
          className="bg-[#10b981] hover:bg-[#059669] text-white"
          onClick={() => setShowForm((v) => !v)}
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
            <h3 className="font-semibold text-lg">Create a plan (about 1 minute)</h3>
            <p className="text-sm text-gray-500">
              Example: “Monthly lawn mowing” · Client: Jane Smith · $150 every month
            </p>

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
                <label className="block text-sm font-semibold mb-1">Client email</label>
                <Input
                  type="email"
                  value={form.clientEmail}
                  onChange={(e) => setForm((f) => ({ ...f, clientEmail: e.target.value }))}
                  placeholder="client@email.com"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Client phone (optional)</label>
              <Input
                value={form.clientPhone}
                onChange={(e) => setForm((f) => ({ ...f, clientPhone: e.target.value }))}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1">Service address</label>
              <Input
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="123 Main St"
              />
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
              <Button
                className="flex-1 bg-[#10b981] hover:bg-[#059669] text-white py-6 text-base"
                disabled={saving}
                onClick={() => void createPlan(true)}
              >
                {saving ? 'Working…' : 'Create & email client for approval'}
              </Button>
              <Button
                variant="outline"
                className="flex-1 py-6"
                disabled={saving}
                onClick={() => void createPlan(false)}
              >
                Create only (email later)
              </Button>
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
              schedule. Your client gets a simple link to subscribe with a card.
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
        <div className="space-y-4">
          {plans.map((p) => (
            <Card key={p.id} className="overflow-hidden">
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
                      {p.clientEmail ? ` · ${p.clientEmail}` : ''}
                    </p>
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
                    {p.clientApprovedAt && (
                      <p className="text-xs font-semibold text-emerald-700 mt-1">
                        ✓ Client approved on {new Date(p.clientApprovedAt).toLocaleString()}
                      </p>
                    )}
                    {p.approvalEmailSentAt && !p.clientApprovedAt && (
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
                    <Button
                      size="sm"
                      className="bg-[#10b981] hover:bg-[#059669] text-white"
                      disabled={busyId === p.id || p.status === 'canceled' || !p.clientEmail}
                      onClick={() => void emailClientApproval(p.id, p.clientEmail)}
                    >
                      📧 Email client for approval
                    </Button>
                    <Button
                      size="sm"
                      className="bg-[#0ea5e9] text-white"
                      disabled={busyId === p.id || p.status === 'canceled'}
                      onClick={() => void copyLink(p.id)}
                    >
                      📋 Copy client link
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyId === p.id || p.status === 'canceled' || p.status === 'active'}
                      onClick={() => void openCheckoutForClient(p.id)}
                    >
                      Open Stripe checkout
                    </Button>
                    {p.status !== 'canceled' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 border-red-200"
                        disabled={busyId === p.id}
                        onClick={() => void cancelPlan(p.id)}
                      >
                        Cancel plan
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-10 rounded-xl border bg-white p-5 text-sm text-gray-600 space-y-2">
        <p className="font-semibold text-gray-900">How it works</p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Create a plan (service, client email, amount, weekly/monthly/yearly).</li>
          <li>
            Tap <strong>Email client for approval</strong> — they get a message with an{' '}
            <strong>Approve recurring charges</strong> button.
          </li>
          <li>
            When they approve, you&apos;ll see <strong>✓ Client approved</strong> on the plan.
          </li>
          <li>They set up a card; Stripe charges automatically each period.</li>
        </ol>
        <p className="text-xs text-gray-500 pt-2">
          Tip: Finish Stripe Connect under Profile → Payments so charges can pay out to your bank.
          Requires Resend email setup (same as estimate send).
        </p>
      </div>
    </div>
  );
}
