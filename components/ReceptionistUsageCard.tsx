'use client';

import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';

type Usage = {
  available: boolean;
  periodEnd: string;
  aiMinutesUsed: number;
  aiMinutesCap: number;
  aiMinutesToday: number;
  aiMinutesDailyCap: number;
  forwardMinutesUsed: number;
  forwardMinutesCap: number;
  leadTextsUsed: number;
  leadTextsCap: number;
  maxCallMinutes: number;
  callsPerCallerPerHour: number;
};

function Bar({ used, cap }: { used: number; cap: number }) {
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="h-2 w-full rounded-full bg-slate-200" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "Minutes used / cap" for the AI Receptionist (caps are automatic; nothing to manage). */
export function ReceptionistUsageCard({ getAccessToken }: { getAccessToken: () => Promise<string | null> }) {
  const [usage, setUsage] = React.useState<Usage | null>(null);
  const tokenRef = React.useRef(getAccessToken);
  React.useEffect(() => {
    tokenRef.current = getAccessToken;
  });

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const token = await tokenRef.current();
        if (!token) return;
        const res = await fetch('/api/receptionist/usage', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const json = await res.json().catch(() => null);
        if (alive && res.ok && json) setUsage(json as Usage);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!usage) return null;
  const renews = usage.periodEnd ? new Date(usage.periodEnd).toLocaleDateString() : '';
  const capped = usage.aiMinutesUsed >= usage.aiMinutesCap;

  return (
    <Card>
      <CardContent className="p-6 space-y-4">
        <div>
          <h3 className="font-semibold text-lg">Usage this month</h3>
          <p className="text-sm text-gray-600">
            Limits are automatic, so there&apos;s nothing to watch. When AI minutes run out, calls
            forward to your transfer number until your plan renews{renews ? ` (${renews})` : ''}.
          </p>
        </div>
        {!usage.available && (
          <p className="text-sm text-amber-700">
            Usage is temporarily unavailable — calls are being forwarded to you for now.
          </p>
        )}
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className="font-medium">AI minutes</span>
            <span className={capped ? 'text-red-600 font-semibold' : 'text-slate-700'}>
              {usage.aiMinutesUsed} / {usage.aiMinutesCap}
            </span>
          </div>
          <Bar used={usage.aiMinutesUsed} cap={usage.aiMinutesCap} />
        </div>
        <div className="space-y-1">
          <div className="flex justify-between text-sm">
            <span>Today</span>
            <span className="text-slate-700">
              {usage.aiMinutesToday} / {usage.aiMinutesDailyCap} min
            </span>
          </div>
          <Bar used={usage.aiMinutesToday} cap={usage.aiMinutesDailyCap} />
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm text-slate-700">
          <div>
            Forwarded: {usage.forwardMinutesUsed} / {usage.forwardMinutesCap} min
          </div>
          <div>
            Lead texts: {usage.leadTextsUsed} / {usage.leadTextsCap}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Each AI call ends after {usage.maxCallMinutes} minutes. A number calling more than{' '}
          {usage.callsPerCallerPerHour} times in an hour hears a busy signal.
        </p>
      </CardContent>
    </Card>
  );
}
