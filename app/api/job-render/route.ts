import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getXaiApiKey, getXaiImageModel } from '@/lib/xai-config';
import { extractMediaStoragePath } from '@/lib/media-url';

/** Image edit is slow — needs elevated duration on Vercel */
export const maxDuration = 120;
export const runtime = 'nodejs';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 8;
const WINDOW_MS = 60 * 1000;

function getApiKey(): string | undefined {
  return (
    process.env.GROK_API_KEY?.trim() ||
    process.env.XAI_API_KEY?.trim() ||
    getXaiApiKey()
  );
}

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
    return { user: null as null, error: 'Unauthorized — log in again' };
  }
  return { user, error: null as null, token };
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

/** Refine an existing AI after-photo using the contractor's plain-language instructions. */
function buildRefinePrompt(
  refineInstruction: string,
  lineDescription?: string,
  notes?: string
): string {
  const scope = lineDescription?.trim()
    ? `\nOriginal job scope (keep this work complete): ${lineDescription.trim()}`
    : '';
  const extra = notes?.trim() ? `\nExtra notes: ${notes.trim()}` : '';
  return `This image is already an AI "after" rendering of a completed construction / repair job. Edit it so it matches the contractor's directions EXACTLY.

Contractor change request:
"${refineInstruction.trim()}"
${scope}${extra}

Requirements:
- Apply the contractor's change request precisely (colors, materials, finishes, missing work, camera details they ask for).
- Keep the same camera angle, framing, and overall scene unless they ask to change those.
- Do not undo completed work unless they ask.
- Stay photorealistic and professional. No watermarks, logos, or text overlays.`;
}

/** Load photo from Supabase storage as a data URL (server-side, no client body size issue). */
async function loadStorageImageAsDataUrl(storagePath: string): Promise<string> {
  const path = extractMediaStoragePath(storagePath) || storagePath.replace(/^\/+/, '');
  if (!path) throw new Error('Invalid photo storage path');

  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error(
      'Server missing SUPABASE_SERVICE_ROLE_KEY. Add it in Vercel Environment Variables and redeploy so AI render can load your photos.'
    );
  }
  const { data, error } = await admin.storage.from('media').download(path);
  if (error || !data) {
    throw new Error(
      `Could not load photo from storage: ${error?.message || 'not found'}. Re-upload the site photo.`
    );
  }
  const buf = Buffer.from(await data.arrayBuffer());
  const mime = data.type || 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function callXaiImageEdit(
  apiKey: string,
  model: string,
  imageDataUrl: string,
  prompt: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const models = [model, 'grok-imagine-image', 'grok-imagine-image-quality'].filter(
    (m, i, arr) => m && arr.indexOf(m) === i
  );

  let lastErr = 'Image edit failed';

  for (const m of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 110_000);

      const response = await fetch('https://api.x.ai/v1/images/edits', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: m,
          prompt,
          image: {
            url: imageDataUrl,
            type: 'image_url',
          },
          n: 1,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text?.slice(0, 500) };
      }

      if (!response.ok) {
        const msg =
          data?.error?.message ||
          data?.error ||
          data?.message ||
          text?.slice(0, 400) ||
          `HTTP ${response.status}`;
        lastErr = typeof msg === 'string' ? msg : JSON.stringify(msg);
        console.error('[job-render] xAI error', m, response.status, lastErr);
        // Try next model on 4xx
        if (response.status === 404 || response.status === 400) continue;
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            'xAI rejected the API key. Check GROK_API_KEY / XAI_API_KEY on Vercel has Imagine image access.'
          );
        }
        continue;
      }

      const item = data?.data?.[0] || data?.[0] || data;
      const b64 = item?.b64_json || item?.b64Json || data?.b64_json;
      const outUrl = item?.url || data?.url || item?.image_url;

      if (b64 && typeof b64 === 'string') {
        const clean = b64.replace(/^data:image\/\w+;base64,/, '');
        return { buffer: Buffer.from(clean, 'base64'), contentType: 'image/png' };
      }

      if (outUrl && typeof outUrl === 'string' && outUrl.startsWith('http')) {
        const imgRes = await fetch(outUrl);
        if (!imgRes.ok) {
          lastErr = `Could not download generated image (${imgRes.status})`;
          continue;
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        return { buffer: buf, contentType };
      }

      lastErr = 'xAI returned no image data';
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        throw new Error(
          'AI image generation timed out (over 100s). Try a simpler photo or try again later.'
        );
      }
      lastErr = e?.message || String(e);
      console.error('[job-render] xAI call exception', m, lastErr);
    }
  }

  throw new Error(lastErr);
}

async function uploadResult(
  userId: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error(
      'Server missing SUPABASE_SERVICE_ROLE_KEY — cannot save AI rendering. Add it in Vercel and redeploy.'
    );
  }
  const ext = contentType.includes('png') ? 'png' : 'jpg';
  const filePath = `${userId}/render/result-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await admin.storage.from('media').upload(filePath, buffer, {
    contentType: contentType.includes('png') ? 'image/png' : 'image/jpeg',
    upsert: true,
    cacheControl: '3600',
  });
  if (error) {
    throw new Error(`Could not save rendering: ${error.message}`);
  }
  return filePath;
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
        { error: 'Invalid request body. Send storagePath + lineDescription only.' },
        { status: 400 }
      );
    }

    const lineDescription = String(body.lineDescription || body.description || '').trim();
    const notes = String(body.notes || '').trim();
    const refineInstruction = String(
      body.refineInstruction || body.instruction || body.changeRequest || ''
    ).trim();
    const mode = String(body.mode || '').toLowerCase() === 'refine' || refineInstruction.length >= 3
      ? 'refine'
      : 'create';
    const storagePathRaw = String(body.storagePath || body.sourcePath || '').trim();
    const imageUrl = String(body.imageUrl || '').trim();
    const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : '';

    if (mode === 'refine') {
      if (refineInstruction.length < 3) {
        return NextResponse.json(
          { error: 'Describe how you want the rendering changed (at least a few words).' },
          { status: 400 }
        );
      }
    } else if (!lineDescription || lineDescription.length < 3) {
      return NextResponse.json(
        { error: 'Link a description line so AI knows what the finished work should look like.' },
        { status: 400 }
      );
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            'GROK_API_KEY (or XAI_API_KEY) is missing on the server. Add it in Vercel → Settings → Environment Variables → Production, then Redeploy.',
        },
        { status: 500 }
      );
    }

    // Resolve source image on the SERVER (tiny client payload)
    let imageDataUrl = '';
    if (storagePathRaw) {
      const path = extractMediaStoragePath(storagePathRaw) || storagePathRaw;
      imageDataUrl = await loadStorageImageAsDataUrl(path);
    } else if (imageUrl.startsWith('http')) {
      // Server downloads the signed URL — client only sent the URL string
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        return NextResponse.json(
          { error: 'Could not load the site photo URL. Re-select the photo and try again.' },
          { status: 400 }
        );
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const mime = imgRes.headers.get('content-type') || 'image/jpeg';
      imageDataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    } else if (imageBase64) {
      imageDataUrl = imageBase64.startsWith('data:image/')
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;
      if (imageDataUrl.length > 3_500_000) {
        return NextResponse.json(
          { error: 'Photo data is too large. Use a photo already uploaded to Site Photos.' },
          { status: 413 }
        );
      }
    } else {
      return NextResponse.json(
        { error: 'No photo provided. Select a Site Photo first.' },
        { status: 400 }
      );
    }

    // Soft shrink: if huge, we still try — xAI accepts data URIs; memory is the risk
    if (imageDataUrl.length > 6_000_000) {
      return NextResponse.json(
        {
          error:
            'Photo is too large for AI processing. Re-upload a smaller photo (under ~2 MB) to Site Photos.',
        },
        { status: 413 }
      );
    }

    const model = getXaiImageModel();
    const prompt =
      mode === 'refine'
        ? buildRefinePrompt(refineInstruction, lineDescription, notes)
        : buildPrompt(lineDescription, notes);

    const { buffer, contentType } = await callXaiImageEdit(apiKey, model, imageDataUrl, prompt);
    if (!buffer?.length) {
      return NextResponse.json(
        { error: 'AI returned an empty image. Try a different photo.' },
        { status: 502 }
      );
    }

    // Save result server-side — client only gets the path (tiny response)
    let resultPath: string | null = null;
    let displayUrl: string | null = null;
    try {
      resultPath = await uploadResult(user.id, buffer, contentType);
      const admin = getSupabaseAdmin();
      if (admin && resultPath) {
        const { data: signed } = await admin.storage
          .from('media')
          .createSignedUrl(resultPath, 60 * 60 * 24);
        displayUrl = signed?.signedUrl || null;
      }
    } catch (uploadErr: any) {
      // Still return base64 if storage upload fails so the feature isn't blocked
      console.error('[job-render] upload failed, returning data URL', uploadErr);
      const b64 = `data:${contentType};base64,${buffer.toString('base64')}`;
      if (b64.length < 3_500_000) {
        return NextResponse.json({
          ok: true,
          imageBase64: b64,
          lineDescription,
          model,
          warning: uploadErr?.message || 'Saved in browser only — storage upload failed',
        });
      }
      throw uploadErr;
    }

    return NextResponse.json({
      ok: true,
      resultPath,
      imageUrl: displayUrl,
      lineDescription,
      refineInstruction: mode === 'refine' ? refineInstruction : undefined,
      mode,
      model,
    });
  } catch (err: any) {
    console.error('[job-render] error:', err);
    const message = err?.message || 'Could not generate job rendering';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Quick health check — confirms route is deployed */
export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'job-render',
    hasGrokKey: Boolean(getApiKey()),
    hasServiceRole: Boolean(getSupabaseAdmin()),
    model: getXaiImageModel(),
  });
}
