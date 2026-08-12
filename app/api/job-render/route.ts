import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getXaiApiKey, getXaiImageModel } from '@/lib/xai-config';

/** Image edit can take 20–60s — allow long enough for Vercel Pro / fluid compute */
export const maxDuration = 120;
export const runtime = 'nodejs';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 6;
const WINDOW_MS = 60 * 1000;

/** Keep request bodies small — huge data URLs cause "Failed to fetch" / 413 */
const MAX_DATA_URL_CHARS = 2_500_000;

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

/**
 * Call xAI image edits. Prefer HTTPS image URLs over huge data URIs so Vercel
 * doesn't drop the request (common cause of browser "Failed to fetch").
 */
async function callImageEdit(
  apiKey: string,
  model: string,
  imageRef: string,
  prompt: string
): Promise<{ imageBase64?: string; imageUrl?: string }> {
  const imagePayload =
    imageRef.startsWith('data:image/') || imageRef.startsWith('http')
      ? { url: imageRef, type: 'image_url' as const }
      : { url: normalizeImageDataUrl(imageRef), type: 'image_url' as const };

  // Prefer URL response (smaller) — fall back to b64 if needed
  const attempts: Array<Record<string, unknown>> = [
    {
      model,
      prompt,
      image: imagePayload,
      n: 1,
    },
    {
      model,
      prompt,
      image: imagePayload,
      response_format: 'url',
      n: 1,
    },
    {
      model,
      prompt,
      image: imagePayload,
      response_format: 'b64_json',
      n: 1,
    },
  ];

  let lastErr = 'Image edit failed';
  for (const body of attempts) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 100_000);
      const response = await fetch('https://api.x.ai/v1/images/edits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

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
          text?.slice(0, 400) ||
          `Image edit failed (${response.status})`;
        lastErr = typeof msg === 'string' ? msg : JSON.stringify(msg);
        // Try next payload shape on 4xx
        if (response.status >= 400 && response.status < 500) continue;
        throw new Error(lastErr);
      }

      const item = data?.data?.[0] || data?.[0] || data;
      const b64 = item?.b64_json || item?.b64Json || data?.b64_json;
      const url = item?.url || data?.url || item?.image_url;

      if (url && typeof url === 'string' && url.startsWith('http')) {
        // Download once on server so client always gets a data URL we control
        try {
          const imgRes = await fetch(url);
          if (imgRes.ok) {
            const buf = Buffer.from(await imgRes.arrayBuffer());
            // Cap response size — re-encode isn't available without sharp; slice risk if huge
            if (buf.length > 8_000_000) {
              return { imageUrl: url };
            }
            const mime = imgRes.headers.get('content-type') || 'image/png';
            return {
              imageBase64: `data:${mime};base64,${buf.toString('base64')}`,
              imageUrl: url,
            };
          }
        } catch {
          /* fall through to return URL */
        }
        return { imageUrl: url };
      }

      if (b64 && typeof b64 === 'string') {
        const clean = b64.replace(/^data:image\/\w+;base64,/, '');
        return { imageBase64: `data:image/png;base64,${clean}` };
      }

      lastErr = 'AI did not return an image URL or base64 payload';
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        throw new Error('AI image generation timed out. Try a smaller photo and try again.');
      }
      lastErr = e?.message || String(e);
    }
  }

  throw new Error(lastErr);
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

    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          error:
            'Could not read request (photo may be too large). Use a smaller site photo and try again.',
        },
        { status: 413 }
      );
    }

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

    // Prefer remote URL (signed Supabase URL) — avoids multi-MB JSON bodies
    let imageRef = '';
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
      imageRef = imageUrl;
    } else if (imageBase64) {
      const dataUrl = normalizeImageDataUrl(imageBase64);
      if (dataUrl.length > MAX_DATA_URL_CHARS) {
        return NextResponse.json(
          {
            error:
              'Photo is too large for AI rendering. Choose a smaller image or take the photo again at normal resolution.',
          },
          { status: 413 }
        );
      }
      imageRef = dataUrl;
    } else if (imageUrl.startsWith('data:image/')) {
      if (imageUrl.length > MAX_DATA_URL_CHARS) {
        return NextResponse.json(
          { error: 'Photo is too large for AI rendering. Try a smaller image.' },
          { status: 413 }
        );
      }
      imageRef = imageUrl;
    } else {
      return NextResponse.json(
        { error: 'A site photo is required for the rendering.' },
        { status: 400 }
      );
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
    const result = await callImageEdit(apiKey, model, imageRef, prompt);

    if (!result.imageBase64 && !result.imageUrl) {
      return NextResponse.json(
        { error: 'AI did not return an image. Try again with a clearer photo.' },
        { status: 502 }
      );
    }

    // Prefer returning imageUrl when base64 is huge (keeps response under limits)
    const payload: Record<string, unknown> = {
      ok: true,
      lineDescription,
      model,
    };
    if (result.imageBase64 && result.imageBase64.length < 4_000_000) {
      payload.imageBase64 = result.imageBase64;
    }
    if (result.imageUrl) {
      payload.imageUrl = result.imageUrl;
    }
    if (!payload.imageBase64 && !payload.imageUrl) {
      payload.imageUrl = result.imageUrl;
      payload.imageBase64 = result.imageBase64;
    }

    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('job-render error:', err);
    const message = err?.message || 'Could not generate job rendering';
    const status = /timeout/i.test(message) ? 504 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
