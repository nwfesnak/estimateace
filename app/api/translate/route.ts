// app/api/translate/route.ts
// Server-side proxy using Grok for single-string or UI dictionary translation.
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 30;
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
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
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

async function callGrok(
  apiKey: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number
) {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getXaiChatModel(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grok translation error: ${errorText}`);
  }

  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || '').trim();
}

function parseJsonObject(raw: string): Record<string, string> | null {
  let s = raw.trim();
  // Strip markdown fences if model wraps JSON
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    /* try extract object */
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(s.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') out[k] = v;
        }
        return out;
      }
    } catch {
      return null;
    }
  }
  return null;
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
    const body = await request.json();
    const from = String(body.from || 'en');
    const to = String(body.to || 'es');
    const mode = String(body.mode || 'text');

    const apiKey = getXaiApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'GROK_API_KEY is missing! Add it in Vercel Environment Variables.' },
        { status: 500 }
      );
    }

    // Bulk UI dictionary: { mode: "dictionary", texts: { key: "English..." }, to: "pt" }
    if (mode === 'dictionary' && body.texts && typeof body.texts === 'object') {
      const texts = body.texts as Record<string, string>;
      const keys = Object.keys(texts);
      if (keys.length === 0) {
        return NextResponse.json({ error: 'texts object is empty' }, { status: 400 });
      }
      if (keys.length > 200) {
        return NextResponse.json({ error: 'Too many keys (max 200)' }, { status: 400 });
      }

      const systemPrompt = `You are a professional software UI translator.
Translate every string value in the JSON object from language code "${from}" to language code "${to}".
Return ONLY a valid JSON object with the SAME keys and translated string values.
Do not add markdown, commentary, or extra keys. Keep placeholders like {count} unchanged.
Use natural, concise UI wording for contractor/estimating software.`;

      const raw = await callGrok(apiKey, systemPrompt, JSON.stringify(texts), 8000);
      const translations = parseJsonObject(raw);
      if (!translations || Object.keys(translations).length === 0) {
        return NextResponse.json(
          { error: 'Could not parse UI translation pack.' },
          { status: 500 }
        );
      }
      // Ensure all original keys exist (fallback to English source if missing)
      const merged: Record<string, string> = {};
      for (const k of keys) {
        merged[k] = translations[k] || texts[k];
      }
      return NextResponse.json({ translations: merged });
    }

    // Single string
    const text = body.text;
    if (!text || typeof text !== 'string' || text.trim().length < 1) {
      return NextResponse.json({ error: 'Valid text is required' }, { status: 400 });
    }

    const systemPrompt = `You are a professional translator. Translate the user's text from language code "${from}" to language code "${to}". Return ONLY the translated text. Do not add any commentary, explanations, or extra text. Preserve meaning, tone, and technical terms.`;

    const translatedText = await callGrok(apiKey, systemPrompt, text, 4000);
    if (!translatedText) {
      return NextResponse.json({ error: 'Could not generate translation.' }, { status: 500 });
    }

    return NextResponse.json({ translatedText });
  } catch (e: any) {
    console.error('Grok translate error:', e);
    return NextResponse.json(
      { error: e?.message || 'Translation failed. Grok service may be unavailable.' },
      { status: 500 }
    );
  }
}
