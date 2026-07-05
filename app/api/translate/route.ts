// app/api/translate/route.ts
// Server-side proxy using the existing Grok API (already installed) for translations.
// Enforces auth + rate limiting.
// Uses Grok for high-quality translations.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 1000;

async function verifyUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, error: 'Unauthorized' };
  }
  const token = authHeader.split(' ')[1];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!supabaseUrl || !supabaseAnonKey) return { user: null, error: 'Supabase not configured' };

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { user: null, error: 'Unauthorized' };
  return { user, error: null };
}

function checkRateLimit(userId: string) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

export async function POST(request: NextRequest) {
  const { user, error: authError } = await verifyUser(request);
  if (!user) {
    return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
  }

  const rate = checkRateLimit(user.id);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: `Rate limit exceeded. Retry in ${rate.retryAfter}s` },
      { status: 429 }
    );
  }

  try {
    const { text, from = 'en', to = 'es' } = await request.json();
    if (!text || typeof text !== 'string' || text.trim().length < 2) {
      return NextResponse.json({ error: 'Valid text is required' }, { status: 400 });
    }

    const apiKey = process.env.GROK_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ 
        error: "GROK_API_KEY is missing! Add it in Vercel Environment Variables." 
      }, { status: 500 });
    }

    const systemPrompt = `You are a professional translator. Translate the user's text from language code "${from}" to language code "${to}". Return ONLY the translated text. Do not add any commentary, explanations, or extra text. Preserve meaning, tone, and technical terms.`;

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-3",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: `Grok translation error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const translatedText = data.choices?.[0]?.message?.content?.trim();

    if (!translatedText) {
      return NextResponse.json({ error: "Could not generate translation." }, { status: 500 });
    }

    return NextResponse.json({ translatedText });
  } catch (e: any) {
    console.error('Grok translate error:', e);
    return NextResponse.json({ error: 'Translation failed. Grok service may be unavailable.' }, { status: 500 });
  }
}
