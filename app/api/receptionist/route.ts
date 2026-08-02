import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';

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
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { user: null, error: 'Unauthorized' };
  return { user, error: null };
}

/**
 * POST /api/receptionist
 * Simulates an AI receptionist call turn or summarizes a full conversation.
 *
 * body: {
 *   mode: 'reply' | 'summarize',
 *   company, knowledgeBase, greeting, languages,
 *   transcript: string,  // full conversation so far
 *   callerMessage?: string, // latest caller line (reply mode)
 *   urgentKeywords?: string,
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await verifyUser(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const mode = body.mode === 'summarize' ? 'summarize' : 'reply';
    const company = String(body.company || 'the company').slice(0, 120);
    const knowledgeBase = String(body.knowledgeBase || '').slice(0, 12000);
    const greeting = String(body.greeting || '').slice(0, 500);
    const languages = Array.isArray(body.languages)
      ? body.languages.map(String).slice(0, 8)
      : ['en'];
    const transcript = String(body.transcript || '').slice(0, 20000);
    const callerMessage = String(body.callerMessage || '').slice(0, 2000);
    const urgentKeywords = String(body.urgentKeywords || 'emergency,urgent,leak,flooding').slice(
      0,
      500
    );

    const apiKey = getXaiApiKey();
    if (!apiKey) {
      return NextResponse.json(
        { error: 'GROK_API_KEY is missing. Add it in Vercel Environment Variables.' },
        { status: 500 }
      );
    }

    const model = getXaiChatModel();
    const langList = languages.join(', ') || 'en';

    let system = '';
    let userContent = '';

    if (mode === 'reply') {
      system = `You are a warm, professional AI phone receptionist for "${company}", a contractor / field service business.
Speak naturally and concisely (1–3 short sentences), like a real front desk person — never say you are an AI unless asked.
You answer business questions ONLY from the knowledge base below (and general courtesy). If you don't know, offer to take a message and have the owner call back.
You can offer to schedule appointments or take a message with name, phone, address, and what they need.
Match the caller's language when possible. Supported languages: ${langList}.
Business greeting style: ${greeting || 'Friendly professional'}

KNOWLEDGE BASE:
${knowledgeBase || '(empty — take a message and offer a callback)'}

Urgent keywords to watch for: ${urgentKeywords}`;

      userContent = `Conversation so far:
${transcript || '(call just started)'}

Caller just said: "${callerMessage || 'Hello'}"

Reply as the receptionist (spoken words only, no stage directions).`;
    } else {
      system = `You analyze a phone conversation with a contractor's AI receptionist.
Return ONLY valid JSON (no markdown) with this shape:
{
  "callerName": "string or Unknown",
  "callerPhone": "string or empty",
  "summary": "2-4 sentence summary of what the caller wants",
  "actionItems": ["short task 1", "task 2"],
  "urgent": true/false,
  "spam": true/false,
  "language": "en|es|fr|...",
  "suggestedAppointment": "YYYY-MM-DD HH:mm or empty if none discussed"
}
Mark urgent if the caller has an emergency or matches urgency. Mark spam if sales/scam/robocall.`;

      userContent = `Company: ${company}
Urgent keywords: ${urgentKeywords}

Full transcript:
${transcript || '(empty)'}`;
    }

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: mode === 'summarize' ? 0.2 : 0.5,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('receptionist xAI error:', res.status, errText);
      return NextResponse.json(
        { error: 'AI receptionist failed. Try again in a moment.' },
        { status: 502 }
      );
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '';

    if (mode === 'reply') {
      return NextResponse.json({ reply: content.replace(/^["']|["']$/g, '') });
    }

    // Parse summarize JSON
    let parsed: Record<string, unknown> = {};
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
    } catch {
      parsed = {
        callerName: 'Unknown',
        callerPhone: '',
        summary: content.slice(0, 800) || 'Caller left a message.',
        actionItems: ['Review call transcript'],
        urgent: false,
        spam: false,
        language: 'en',
        suggestedAppointment: '',
      };
    }

    return NextResponse.json({
      callerName: String(parsed.callerName || 'Unknown'),
      callerPhone: String(parsed.callerPhone || ''),
      summary: String(parsed.summary || ''),
      actionItems: Array.isArray(parsed.actionItems)
        ? parsed.actionItems.map(String)
        : [],
      urgent: !!parsed.urgent,
      spam: !!parsed.spam,
      language: String(parsed.language || 'en'),
      suggestedAppointment: String(parsed.suggestedAppointment || ''),
    });
  } catch (e) {
    console.error('receptionist route:', e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
