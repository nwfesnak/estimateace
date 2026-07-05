// app/api/ai-quote/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Simple in-memory rate limiter (per-user, resets on server restart)
// For production: use Redis / Upstash / Vercel KV with proper middleware
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 10; // requests
const WINDOW_MS = 60 * 1000; // 1 minute

async function verifyUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.split(' ')[1];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { user: null, error: 'Supabase not configured' };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null, error: 'Unauthorized' };
  }

  return { user, error: null };
}

function checkRateLimit(userId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }

  entry.count += 1;
  return { allowed: true };
}

export async function POST(request: NextRequest) {
  try {
    // 1. Auth check
    const { user, error: authError } = await verifyUser(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    // 2. Basic rate limiting (demo - see comment above)
    const rateCheck = checkRateLimit(user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.` },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } }
      );
    }

    const apiKey = process.env.GROK_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'GROK_API_KEY is missing! In Vercel: Settings → Environment Variables → Add New. In the "Key" field type exactly: GROK_API_KEY. In the "Value" field paste the real key from https://console.x.ai/. Select Production and Save. Then redeploy.' }, { status: 500 });
    }

    const { description } = await request.json();
    if (!description?.trim() || description.trim().length < 3) {
      return NextResponse.json({ error: 'Description must be at least 3 characters' }, { status: 400 });
    }

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [
          {
            role: 'system',
            content: `You are a professional contractor cost estimator.
Research current 2026 online market prices to calculate the line-item price internally.

For the line item below, return ONLY valid JSON.

CRITICAL RULES:
- List EVERY material that could be needed for the job — be exhaustive and specific (fasteners, adhesives, primer, tape, connectors, consumables, waste factor items, etc.). Aim for 8–20 material lines when the job warrants it.
- materials array: include description, qty, unit, unitPrice, and total for each material using realistic 2026 US market prices.
- laborBreakdown: include description, hours, rate (per hour), and total labor cost.
- materialsCostTotal: sum of all material totals.
- laborCostTotal: same as laborBreakdown.total.
- unitPrice MUST equal materialsCostTotal + laborCostTotal (the built-up line price before qty multiplier).
- breakdown field: explain scope in plain language without listing every dollar amount in prose.
- Use current 2026 US market prices.

{
  "suggestedDescription": "Clean, professional, customer-friendly description",
  "unitPrice": number,
  "unit": string,
  "suggestedQty": number,
  "total": number,
  "breakdown": "Scope summary",
  "confidence": "high" | "medium" | "low",
  "materialsCostTotal": number,
  "laborCostTotal": number,
  "materials": [
    { "description": "Specific material name/size/type", "qty": number, "unit": "pieces|sqft|lf|gallons|lbs|bags|rolls|etc", "unitPrice": number, "total": number }
  ],
  "laborBreakdown": {
    "description": "Labor tasks involved",
    "hours": number,
    "rate": number,
    "total": number
  }
}`
          },
          { role: 'user', content: description }
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: `xAI API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const aiText = data.choices?.[0]?.message?.content || '';

    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!parsed || typeof parsed.unitPrice !== 'number') {
      return NextResponse.json({ error: 'AI returned invalid format' }, { status: 500 });
    }

    const rawMaterials = Array.isArray(parsed.materials)
      ? parsed.materials
      : parsed.materialBreakdown
        ? [parsed.materialBreakdown]
        : [];

    const materials = rawMaterials
      .filter((m: { description?: string }) => m?.description?.trim())
      .map((m: { description?: string; qty?: number; unit?: string; unitPrice?: number; total?: number }) => {
        const qty = typeof m.qty === 'number' ? m.qty : 1;
        const unitPrice = typeof m.unitPrice === 'number' ? m.unitPrice : 0;
        const total = typeof m.total === 'number' ? m.total : qty * unitPrice;
        return {
          description: String(m.description).trim(),
          qty,
          unit: m.unit ? String(m.unit).trim() : 'ea',
          unitPrice,
          total,
        };
      });

    const laborBreakdown = parsed.laborBreakdown
      ? {
          description: String(parsed.laborBreakdown.description || 'Labor').trim(),
          hours: typeof parsed.laborBreakdown.hours === 'number' ? parsed.laborBreakdown.hours : 0,
          rate: typeof parsed.laborBreakdown.rate === 'number' ? parsed.laborBreakdown.rate : 0,
          total: typeof parsed.laborBreakdown.total === 'number'
            ? parsed.laborBreakdown.total
            : (parsed.laborBreakdown.hours || 0) * (parsed.laborBreakdown.rate || 0),
        }
      : null;

    const materialsCostTotal = typeof parsed.materialsCostTotal === 'number'
      ? parsed.materialsCostTotal
      : materials.reduce((sum: number, m: { total: number }) => sum + m.total, 0);
    const laborCostTotal = typeof parsed.laborCostTotal === 'number'
      ? parsed.laborCostTotal
      : (laborBreakdown?.total || 0);

    return NextResponse.json({
      suggestedDescription: parsed.suggestedDescription,
      unitPrice: parsed.unitPrice,
      unit: parsed.unit,
      suggestedQty: parsed.suggestedQty,
      total: parsed.total,
      breakdown: parsed.breakdown,
      confidence: parsed.confidence,
      materials,
      materialsCostTotal,
      laborCostTotal,
      laborBreakdown,
    });
  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}