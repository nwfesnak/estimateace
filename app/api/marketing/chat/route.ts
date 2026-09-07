import { NextRequest, NextResponse } from 'next/server';
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';
import { MARKETING_FALLBACK, MARKETING_KNOWLEDGE } from '@/lib/marketing-knowledge';
import { sendEmailNotification } from '@/lib/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ORIGINS = new Set([
  'https://estimateace.com',
  'https://www.estimateace.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;

function corsHeaders(origin: string | null): HeadersInit {
  const allow =
    origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://estimateace.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function checkRateLimit(id: string) {
  const now = Date.now();
  const entry = rateLimitMap.get(id);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(id, { count: 1, resetTime: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

function supportInbox(): string {
  return (
    (process.env.ADMIN_EMAIL || '').trim() ||
    (process.env.SUPPORT_EMAIL || '').trim() ||
    (process.env.NEXT_PUBLIC_SUPPORT_EMAIL || '').trim() ||
    'support@estimateace.com'
  );
}

function looksLikeConfidentAnswer(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes('__need_human__')) return false;
  if (t.includes("i don't know") || t.includes('i do not know')) return false;
  if (t.includes("i'm not sure") || t.includes('i am not sure')) return false;
  if (t.includes("can't find") || t.includes('cannot find')) return false;
  if (t.includes('someone will get back') || t.includes('within 48 hours') || t.includes('within 49 hours')) return false;
  return text.trim().length > 40;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get('origin')),
  });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const headers = corsHeaders(origin);

  try {
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return NextResponse.json({ error: 'Origin not allowed' }, { status: 403, headers });
    }

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';
    if (!checkRateLimit(`mkt-chat:${ip}`)) {
      return NextResponse.json(
        { error: 'Too many messages. Please try again later.' },
        { status: 429, headers }
      );
    }

    const body = await request.json().catch(() => ({}));
    const question = String(body.question || body.message || '').trim().slice(0, 1500);
    const name = String(body.name || '').trim().slice(0, 120);
    const email = String(body.email || '').trim().slice(0, 200);
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

    if (!question) {
      return NextResponse.json({ error: 'Please enter a question.' }, { status: 400, headers });
    }

    const apiKey = getXaiApiKey();
    let answer = '';
    let needsHuman = false;

    if (!apiKey) {
      needsHuman = true;
      answer = MARKETING_FALLBACK;
    } else {
      const historyText = history
        .map((h: any) => `${h.role === 'assistant' ? 'Assistant' : 'Visitor'}: ${String(h.text || '').slice(0, 500)}`)
        .join('\n');

      const system = `You are the EstimateAce website assistant for contractors interested in the product.
Answer ONLY using the knowledge base below. Be concise (2–5 short sentences), friendly, and accurate.
If the question is outside the knowledge base, or you are unsure, reply with exactly this token on its own first line: __NEED_HUMAN__
Then on the following lines give a brief polite note.

Knowledge base:
${MARKETING_KNOWLEDGE}`;

      const userContent = [
        historyText ? `Recent chat:\n${historyText}\n` : '',
        `Visitor question: ${question}`,
        name ? `Visitor name: ${name}` : '',
        email ? `Visitor email: ${email}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: getXaiChatModel(),
          temperature: 0.2,
          max_tokens: 500,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
        }),
      });

      const json = await res.json().catch(() => ({}));
      const raw = String(json?.choices?.[0]?.message?.content || '').trim();

      if (!res.ok || !raw) {
        needsHuman = true;
        answer = MARKETING_FALLBACK;
      } else if (raw.includes('__NEED_HUMAN__') || !looksLikeConfidentAnswer(raw)) {
        needsHuman = true;
        answer = MARKETING_FALLBACK;
      } else {
        answer = raw.replace(/__NEED_HUMAN__/g, '').trim();
        needsHuman = false;
      }
    }

    // Email the team when we need a human, or when visitor left contact info with a hard question
    if (needsHuman || (email && email.includes('@'))) {
      const inbox = supportInbox();
      void sendEmailNotification(
        inbox,
        needsHuman
          ? `[Website chat] Needs reply within 48h`
          : `[Website chat] Lead question`,
        [
          `Question: ${question}`,
          `AI answered confidently: ${needsHuman ? 'no' : 'yes'}`,
          `AI reply shown to visitor: ${answer}`,
          '',
          `Name: ${name || '(not provided)'}`,
          `Email: ${email || '(not provided)'}`,
          `IP: ${ip}`,
          `Origin: ${origin || '(none)'}`,
        ].join('\n'),
        { companyName: 'EstimateAce Website' }
      ).catch((e) => console.warn('marketing chat notify:', e));
    }

    return NextResponse.json(
      {
        ok: true,
        answer,
        needsHuman,
        followUpHours: needsHuman ? 48 : null,
      },
      { headers }
    );
  } catch (e: any) {
    console.error('marketing/chat:', e);
    return NextResponse.json(
      { ok: true, answer: MARKETING_FALLBACK, needsHuman: true, followUpHours: 48 },
      { headers: corsHeaders(origin) }
    );
  }
}
