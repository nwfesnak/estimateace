import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  PLATFORM_TUTORIALS_ROW_ID,
  isPlatformAdminEmail,
  normalizeTutorialsList,
  type PlatformTutorial,
} from '@/lib/platform-tutorials';

async function loadCatalog(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>): Promise<{
  videos: PlatformTutorial[];
  ownerUserId: string | null;
}> {
  const { data } = await admin
    .from('estimates')
    .select('profile, user_id')
    .eq('id', PLATFORM_TUTORIALS_ROW_ID)
    .maybeSingle();
  const profile = (data?.profile || {}) as any;
  return {
    videos: normalizeTutorialsList(profile.videos),
    ownerUserId: data?.user_id || null,
  };
}

async function saveCatalog(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  ownerUserId: string,
  videos: PlatformTutorial[]
) {
  const { error } = await admin.from('estimates').upsert(
    {
      id: PLATFORM_TUTORIALS_ROW_ID,
      user_id: ownerUserId,
      invoiceNumber: PLATFORM_TUTORIALS_ROW_ID,
      jobName: 'EstimateAce video tutorials',
      documentType: 'estimate',
      items: [],
      profile: { videos },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(error.message);
}

/**
 * GET — list platform tutorials (any logged-in user).
 * POST — upload video (platform admin only). multipart: file, title?, description?
 * DELETE — remove video (platform admin only). body: { id }
 */
export async function GET(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const canManage = isPlatformAdminEmail(user.email);
    const { videos } = await loadCatalog(admin);

    const withUrls = await Promise.all(
      videos.map(async (v) => {
        let videoUrl = '';
        try {
          const { data: signed } = await admin.storage
            .from('media')
            .createSignedUrl(v.storagePath, 60 * 60 * 6);
          videoUrl = signed?.signedUrl || '';
        } catch {
          /* optional */
        }
        return { ...v, videoUrl };
      })
    );

    return NextResponse.json({
      ok: true,
      canManage,
      videos: withUrls,
    });
  } catch (e: any) {
    console.error('tutorials GET:', e);
    return NextResponse.json({ error: e?.message || 'Failed to load tutorials' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    if (!isPlatformAdminEmail(user.email)) {
      return NextResponse.json(
        {
          error:
            'Only the EstimateAce owner can upload tutorials. Set PLATFORM_ADMIN_EMAILS (or NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS) to your login email in Vercel.',
        },
        { status: 403 }
      );
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const form = await request.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 });
    }

    const file = form.get('file');
    if (!file || !(file instanceof Blob) || !(file as any).name) {
      return NextResponse.json({ error: 'Video file is required.' }, { status: 400 });
    }

    const title = String(form.get('title') || (file as any).name || 'Tutorial').slice(0, 200);
    const description = String(form.get('description') || '').slice(0, 2000);
    const fileName = String((file as any).name || 'tutorial.mp4').slice(0, 200);
    const lower = fileName.toLowerCase();
    if (!/\.(mp4|webm|mov|m4v|ogg)$/i.test(lower) && !String(file.type || '').startsWith('video/')) {
      return NextResponse.json(
        { error: 'Please upload a video file (MP4, WebM, MOV).' },
        { status: 400 }
      );
    }

    const maxBytes = 200 * 1024 * 1024; // 200MB
    if (typeof (file as any).size === 'number' && (file as any).size > maxBytes) {
      return NextResponse.json({ error: 'Video must be under 200 MB.' }, { status: 400 });
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
    const storagePath = `platform-tutorials/${Date.now()}-${safeName}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const contentType = file.type || 'video/mp4';

    const { error: upErr } = await admin.storage.from('media').upload(storagePath, buffer, {
      contentType,
      upsert: false,
    });
    if (upErr) {
      return NextResponse.json(
        { error: upErr.message || 'Upload to storage failed. Check media bucket policies.' },
        { status: 500 }
      );
    }

    const { videos, ownerUserId } = await loadCatalog(admin);
    const entry: PlatformTutorial = {
      id: `tut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      description,
      storagePath,
      fileName,
      createdAt: new Date().toISOString(),
      createdByEmail: user.email || undefined,
    };
    const next = [entry, ...videos];
    await saveCatalog(admin, ownerUserId || user.id, next);

    let videoUrl = '';
    try {
      const { data: signed } = await admin.storage
        .from('media')
        .createSignedUrl(storagePath, 60 * 60 * 6);
      videoUrl = signed?.signedUrl || '';
    } catch {
      /* optional */
    }

    return NextResponse.json({ ok: true, video: { ...entry, videoUrl }, videos: next.length });
  } catch (e: any) {
    console.error('tutorials POST:', e);
    return NextResponse.json({ error: e?.message || 'Upload failed' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    if (!isPlatformAdminEmail(user.email)) {
      return NextResponse.json({ error: 'Only the EstimateAce owner can delete tutorials.' }, { status: 403 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const id = String(body.id || '').trim();
    if (!id) {
      return NextResponse.json({ error: 'Video id is required.' }, { status: 400 });
    }

    const { videos, ownerUserId } = await loadCatalog(admin);
    const target = videos.find((v) => v.id === id);
    if (!target) {
      return NextResponse.json({ error: 'Tutorial not found.' }, { status: 404 });
    }

    try {
      await admin.storage.from('media').remove([target.storagePath]);
    } catch {
      /* still remove catalog entry */
    }

    const next = videos.filter((v) => v.id !== id);
    await saveCatalog(admin, ownerUserId || user.id, next);

    return NextResponse.json({ ok: true, remaining: next.length });
  } catch (e: any) {
    console.error('tutorials DELETE:', e);
    return NextResponse.json({ error: e?.message || 'Delete failed' }, { status: 500 });
  }
}
