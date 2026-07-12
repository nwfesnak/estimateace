import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';

// Simple rate limiter (demo only)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 15;
const WINDOW_MS = 60 * 1000;

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
  try {
    // Auth + Rate limit
    const { user, error: authError } = await verifyUser(request);
    if (!user) {
      return NextResponse.json({ suggestion: authError || 'Unauthorized' }, { status: 401 });
    }

    const rate = checkRateLimit(user.id);
    if (!rate.allowed) {
      return NextResponse.json(
        { suggestion: `Rate limit exceeded. Try again in ${rate.retryAfter}s.` },
        { status: 429 }
      );
    }

    const { description } = await request.json();

    if (!description || description.trim().length < 5) {
      return NextResponse.json({ 
        suggestion: "Please type a longer description first!" 
      }, { status: 400 });
    }

    const apiKey = getXaiApiKey();

    if (!apiKey) {
      return NextResponse.json({ 
        error: "GROK_API_KEY is missing! In Vercel: go to Settings → Environment Variables → 'Add New'. In the 'Key' field, type exactly GROK_API_KEY (no xai-, no dashes). In the 'Value' field, paste your real key from https://console.x.ai/. Select Production. Save and Redeploy." 
      }, { status: 500 });
    }

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getXaiChatModel(),
        messages: [
          {
            role: "system",
            content: `You are a professional construction estimator writing customer-facing estimate line descriptions.

Rewrite the contractor's rough notes into a polished description that clearly showcases the job's features and scope. The customer should understand exactly what work is included and what makes this line item valuable.

Include when known from the input:
- Scope of work (what is being done, repaired, installed, or replaced)
- Key materials, products, or finishes (brand/grade only if mentioned)
- Size, quantity, area, or dimensions
- Notable features (tear-off, disposal, prep, priming, sealing, code compliance, warranty, etc.)
- Quality or method details that matter to the homeowner

Style rules:
- Professional, confident, and specific — not generic filler
- 2–4 sentences or one tight paragraph; use short phrases separated by semicolons if it reads better
- No pricing, labor hours, or dollar amounts
- No preamble like "We will" — start with the work itself
- Return ONLY the improved description, no quotes or extra commentary`
          },
          {
            role: "user",
            content: description
          }
        ],
        temperature: 0.65,
        max_tokens: 400,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ 
        error: `xAI API Error: ${errorText}` 
      }, { status: response.status });
    }

    const data = await response.json();
    const suggestion = data.choices?.[0]?.message?.content?.trim();

    if (!suggestion) {
      return NextResponse.json({ 
        error: "Could not generate improvement. The model returned an empty response." 
      }, { status: 500 });
    }

    return NextResponse.json({ suggestion });

  } catch (error) {
    console.error("Grok API error:", error);
    return NextResponse.json({ 
      error: "Sorry, Grok AI is temporarily unavailable. Please try again later." 
    }, { status: 500 });
  }
}