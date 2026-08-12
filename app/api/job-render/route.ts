import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getXaiApiKey, getXaiImageModel } from '@/lib/xai-config';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 6;
const WINDOW_MS = 60 * 1000;

async function verifyUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null as null, error: 'Missing or invalid Authorization header' };
  }
  const token = authHeader.split(' ')[1];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!supabaseUrl || !supabaseAnonKey) {
    return { user: null as null, error: 'Supabase not configured' };
  }
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null as null, error: 'Unauthorized' };
  }
  return { user, error: null as null };
}

function checkRateLimit(userId: string) {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true as const };
  }
  if (entry.count >= RATE_LIMIT) {
    return {
      allowed: false as const,
      retryAfter: Math.ceil((entry.resetTime - now) / 1000),
    };
  }
  entry.count++;
  return { allowed: true as const };
}

function normalizeImageDataUrl(imageBase64: string): string {
  const trimmed = imageBase64.trim();
  if (trimmed.startsWith('data:image/')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

function buildPrompt(lineDescription: string, notes?: string): string {
  const scope = lineDescription.trim() || 'the contracted construction / repair work';
  const extra = notes?.trim() ? `\nAdditional contractor notes: ${notes.trim()}` : '';
  return `This is a real before / site photo of a property. Create a realistic photorealistic "after" rendering of the same exact location after the following work is fully completed: ${scope}.${extra}

Requirements:
- Keep the same camera angle, perspective, framing, lighting time-of-day, and surrounding context as the original photo.
- Only change what the completed job would change (materials, finishes, repairs, paint, roofing, landscaping, fixtures, etc. described in the scope).
- Make the result look finished, clean, and professional — as a contractor would show a customer for approval.
- Photorealistic, not cartoon or illustration. No text watermarks, logos, or price tags.`;
}

async function callImageEdit(apiKey: string, model: string, imageDataUrl: string, prompt: string) {
  const response = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt,
      image: {
        url: imageDataUrl,
        type: 'image_url',
      },
      response_format: 'b64_json',
      n: 1,
    }),
  });

  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const msg =
      data?.error?.message ||
      data?.error ||
      data?.message ||
      text?.slice(0, 300) ||
      `Image edit failed (${response.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  const item = data?.data?.[0] || data?.[0] || data;
  const b64 = item?.b64_json || item?.b64Json || data?.b64_json;
  const url = item?.url || data?.url;

  if (b64 && typeof b64 === 'string') {
    return { imageBase64: `data:image/png;base64,${b64.replace(/^data:image\/\w+;base64,/, '')}` };
  }
  if (url && typeof url === 'string') {
    // Fetch temporary URL → base64 so client can store permanently
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error('Could not download generated image');
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const mime = imgRes.headers.get('content-type') || 'image/png';
    return { imageBase64: `data:${mime};base64,${buf.toString('base64')}`, temporaryUrl: url };
  }

  throw new Error('AI did not return an image. Try again or use a clearer site photo.');
}

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await verifyUser(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const rate = checkRateLimit(user.id);
    if (!rate.allowed) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Try again in ${rate.retryAfter}s.` },
        { status: 429 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const lineDescription = String(body.lineDescription || body.description || '').trim();
    const notes = String(body.notes || '').trim();
    const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';

    if (!lineDescription || lineDescription.length < 3) {
      return NextResponse.json(
        { error: 'Link a description line so AI knows what the completed job should look like.' },
        { status: 400 }
      );
    }

    let imageDataUrl = '';
    if (imageBase64) {
      imageDataUrl = normalizeImageDataUrl(imageBase64);
    } else if (imageUrl) {
      // Prefer data URLs or publicly reachable URLs; signed URLs work if still valid
      if (imageUrl.startsWith('data:image/')) {
        imageDataUrl = imageUrl;
      } else {
        const imgRes = await fetch(imageUrl);
        if (!imgRes.ok) {
          return NextResponse.json(
            { error: 'Could not load the source photo. Re-upload or pick another site photo.' },
            { status: 400 }
          );
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const mime = imgRes.headers.get('content-type') || 'image/jpeg';
        imageDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      }
    } else {
      return NextResponse.json({ error: 'A site photo is required for the rendering.' }, { status: 400 });
    }

    const apiKey = getXaiApiKey();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'GROK_API_KEY is missing. Add it in Vercel → Environment Variables, then redeploy.',
        },
        { status: 500 }
      );
    }

    const model = getXaiImageModel();
    const prompt = buildPrompt(lineDescription, notes);
    const result = await callImageEdit(apiKey, model, imageDataUrl, prompt);

    return NextResponse.json({
      ok: true,
      imageBase64: result.imageBase64,
      lineDescription,
      model,
    });
  } catch (err: any) {
    console.error('job-render error:', err);
    const message = err?.message || 'Could not generate job rendering';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
