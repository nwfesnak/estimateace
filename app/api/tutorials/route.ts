import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  PLATFORM_TUTORIALS_ROW_ID,
  isAllowedTutorialUrl,
  isPlatformAdminEmail,
  normalizeLinkTutorials,
  normalizeTutorialsList,
  type PlatformTutorial,
} from '@/lib/platform-tutorials';

function missingTable(error: { message?: string; code?: string } | null | undefined): boolean {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /does not exist|could not find the table/i.test(message)
  );
}

async function loadLegacyFiles(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>): Promise<{
  videos: PlatformTutorial[];
  ownerUserId: string | null;
}> {
  const { data } = await admin
    .from('estimates')
    .select('profile, user_id')
    .eq('id', PLATFORM_TUTORIALS_ROW_ID)
    .maybeSingle();
  const profile = (data?.profile || {}) as { videos?: unknown };
  return {
    videos: normalizeTutorialsList(profile.videos),
    ownerUserId: data?.user_id || null,
  };
}

async function saveLegacyFiles(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  ownerUserId: string,
  videos: PlatformTutorial[]
) {
  const catalog = videos
    .filter((v) => v.kind === 'file' && v.storagePath)
    .map((v) => ({
      id: v.id,
      title: v.title,
      description: v.description,
      storagePath: v.storagePath,
      fileName: v.fileName || '',
      createdAt: v.createdAt,
      createdByEmail: v.createdByEmail,
    }));
  const { error } = await admin.from('estimates').upsert(
    {
      id: PLATFORM_TUTORIALS_ROW_ID,
      user_id: ownerUserId,
      invoiceNumber: PLATFORM_TUTORIALS_ROW_ID,
      jobName: 'EstimateAce video tutorials',
      documentType: 'estimate',
      items: [],
      profile: { videos: catalog },
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(error.message);
}

async function loadLinkTutorials(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>): Promise<{
  videos: PlatformTutorial[];
  tableReady: boolean;
}> {
  const { data, error } = await admin
    .from('app_tutorials')
    .select('id, title, description, url, sort_order, created_at, created_by_email')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    if (missingTable(error)) return { videos: [], tableReady: false };
    throw new Error(error.message);
  }
  return { videos: normalizeLinkTutorials(data), tableReady: true };
}

async function signFileUrls(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  files: PlatformTutorial[]
): Promise<PlatformTutorial[]> {
  return Promise.all(
    files.map(async (v) => {
      if (!v.storagePath) return v;
      let url = v.url || '';
      try {
        const { data: signed } = await admin.storage
          .from('media')
          .createSignedUrl(v.storagePath, 60 * 60 * 6);
        url = signed?.signedUrl || url;
      } catch {
        /* optional */
      }
      return { ...v, url };
    })
  );
}

function requireAdmin(userEmail: string | null | undefined): NextResponse | null {
  if (isPlatformAdminEmail(userEmail)) return null;
  return NextResponse.json(
    {
      error:
        'Only an EstimateAce platform admin can change tutorials. Set PLATFORM_ADMIN_EMAILS if your login is not already on the allowlist.',
    },
    { status: 403 }
  );
}

/**
 * GET — list platform tutorials (any logged-in user).
 * POST JSON { title, description?, url } — add a hyperlink (platform admin).
 * POST multipart { file, title?, description? } — upload a video file (platform admin, legacy).
 * PATCH { id, title?, description?, url? } or { orderedIds: string[] } — edit or reorder (admin).
 * DELETE { id } — remove a tutorial (admin).
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
    const { videos: links } = await loadLinkTutorials(admin);
    const { videos: files } = await loadLegacyFiles(admin);
    const withUrls = await signFileUrls(admin, files);

    return NextResponse.json({
      ok: true,
      canManage,
      videos: [...links, ...withUrls],
    });
  } catch (e: unknown) {
    console.error('tutorials GET:', e);
    return NextResponse.json({ error: 'Failed to load tutorials' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const denied = requireAdmin(user.email);
    if (denied) return denied;

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      const title = String(body.title || '').trim().slice(0, 200);
      const description = String(body.description || '').trim().slice(0, 2000);
      const url = String(body.url || body.href || '').trim();
      if (!title) {
        return NextResponse.json({ error: 'A title is required.' }, { status: 400 });
      }
      if (!isAllowedTutorialUrl(url)) {
        return NextResponse.json(
          { error: 'Enter a valid http(s) video link (YouTube, Vimeo, or any https URL).' },
          { status: 400 }
        );
      }

      const { videos, tableReady } = await loadLinkTutorials(admin);
      if (!tableReady) {
        return NextResponse.json(
          { error: 'Tutorial storage is not ready yet. The app_tutorials migration still needs to be applied.' },
          { status: 503 }
        );
      }
      const nextOrder =
        videos.reduce((max, v) => Math.max(max, Number(v.sortOrder) || 0), -1) + 1;
      const { data, error } = await admin
        .from('app_tutorials')
        .insert({
          title,
          description: description || null,
          url,
          sort_order: nextOrder,
          created_by_email: user.email || null,
        })
        .select('id, title, description, url, sort_order, created_at, created_by_email')
        .maybeSingle();
      if (error || !data) {
        return NextResponse.json({ error: error?.message || 'Could not save the tutorial.' }, { status: 500 });
      }
      const video = normalizeLinkTutorials([data])[0];
      return NextResponse.json({ ok: true, video, videos: videos.length + 1 });
    }

    // Legacy file upload
    const form = await request.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: 'Expected JSON { title, url } or a video file upload.' }, { status: 400 });
    }

    const file = form.get('file');
    if (!file || !(file instanceof Blob) || !(file as File).name) {
      return NextResponse.json({ error: 'Video file is required.' }, { status: 400 });
    }

    const title = String(form.get('title') || (file as File).name || 'Tutorial').slice(0, 200);
    const description = String(form.get('description') || '').slice(0, 2000);
    const fileName = String((file as File).name || 'tutorial.mp4').slice(0, 200);
    const lower = fileName.toLowerCase();
    if (!/\.(mp4|webm|mov|m4v|ogg)$/i.test(lower) && !String(file.type || '').startsWith('video/')) {
      return NextResponse.json(
        { error: 'Please upload a video file (MP4, WebM, MOV).' },
        { status: 400 }
      );
    }

    const maxBytes = 200 * 1024 * 1024;
    if (typeof (file as File).size === 'number' && (file as File).size > maxBytes) {
      return NextResponse.json({ error: 'Video must be under 200 MB.' }, { status: 400 });
    }

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
    const storagePath = `platform-tutorials/${Date.now()}-${safeName}`;
    const buffer = Buffer.from(await file.arrayBuffer());
    const contentTypeUpload = file.type || 'video/mp4';

    const { error: upErr } = await admin.storage.from('media').upload(storagePath, buffer, {
      contentType: contentTypeUpload,
      upsert: false,
    });
    if (upErr) {
      return NextResponse.json(
        { error: upErr.message || 'Upload to storage failed. Check media bucket policies.' },
        { status: 500 }
      );
    }

    const { videos, ownerUserId } = await loadLegacyFiles(admin);
    const entry: PlatformTutorial = {
      id: `tut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      description,
      url: '',
      sortOrder: 10000 + videos.length,
      createdAt: new Date().toISOString(),
      createdByEmail: user.email || undefined,
      kind: 'file',
      storagePath,
      fileName,
    };
    const next = [entry, ...videos];
    await saveLegacyFiles(admin, ownerUserId || user.id, next);

    const signed = (await signFileUrls(admin, [entry]))[0];
    return NextResponse.json({ ok: true, video: signed, videos: next.length });
  } catch (e: unknown) {
    console.error('tutorials POST:', e);
    return NextResponse.json({ error: 'Could not save the tutorial.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const denied = requireAdmin(user.email);
    if (denied) return denied;

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const orderedIds = Array.isArray(body.orderedIds)
      ? body.orderedIds.map((id: unknown) => String(id || '').trim()).filter(Boolean)
      : null;

    if (orderedIds) {
      const { videos, tableReady } = await loadLinkTutorials(admin);
      if (!tableReady) {
        return NextResponse.json({ error: 'Tutorial storage is not ready yet.' }, { status: 503 });
      }
      const allowed = new Set(videos.map((v) => v.id));
      const unique = orderedIds.filter((id: string, i: number) => allowed.has(id) && orderedIds.indexOf(id) === i);
      if (!unique.length) {
        return NextResponse.json({ error: 'No tutorial ids to reorder.' }, { status: 400 });
      }
      for (let i = 0; i < unique.length; i += 1) {
        const { error } = await admin
          .from('app_tutorials')
          .update({ sort_order: i, updated_at: new Date().toISOString() })
          .eq('id', unique[i]);
        if (error) {
          return NextResponse.json({ error: error.message || 'Reorder failed.' }, { status: 500 });
        }
      }
      const { videos: next } = await loadLinkTutorials(admin);
      return NextResponse.json({ ok: true, videos: next });
    }

    const id = String(body.id || '').trim();
    if (!id) {
      return NextResponse.json({ error: 'Tutorial id is required.' }, { status: 400 });
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.title != null) {
      const title = String(body.title).trim().slice(0, 200);
      if (!title) return NextResponse.json({ error: 'A title is required.' }, { status: 400 });
      patch.title = title;
    }
    if (body.description != null) {
      patch.description = String(body.description).trim().slice(0, 2000) || null;
    }
    if (body.url != null || body.href != null) {
      const url = String(body.url || body.href || '').trim();
      if (!isAllowedTutorialUrl(url)) {
        return NextResponse.json(
          { error: 'Enter a valid http(s) video link (YouTube, Vimeo, or any https URL).' },
          { status: 400 }
        );
      }
      patch.url = url;
    }
    const { data, error } = await admin
      .from('app_tutorials')
      .update(patch)
      .eq('id', id)
      .select('id, title, description, url, sort_order, created_at, created_by_email')
      .maybeSingle();
    if (error) {
      if (missingTable(error)) {
        return NextResponse.json({ error: 'Tutorial storage is not ready yet.' }, { status: 503 });
      }
      return NextResponse.json({ error: error.message || 'Could not update the tutorial.' }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'Tutorial not found.' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, video: normalizeLinkTutorials([data])[0] });
  } catch (e: unknown) {
    console.error('tutorials PATCH:', e);
    return NextResponse.json({ error: 'Could not update the tutorial.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const denied = requireAdmin(user.email);
    if (denied) return denied;

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
      return NextResponse.json({ error: 'Tutorial id is required.' }, { status: 400 });
    }

    const { data: link, error: linkErr } = await admin
      .from('app_tutorials')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (linkErr && !missingTable(linkErr)) {
      return NextResponse.json({ error: linkErr.message }, { status: 500 });
    }
    if (link?.id) {
      const { error } = await admin.from('app_tutorials').delete().eq('id', id);
      if (error) {
        return NextResponse.json({ error: error.message || 'Delete failed.' }, { status: 500 });
      }
      return NextResponse.json({ ok: true });
    }

    const { videos, ownerUserId } = await loadLegacyFiles(admin);
    const target = videos.find((v) => v.id === id);
    if (!target) {
      return NextResponse.json({ error: 'Tutorial not found.' }, { status: 404 });
    }
    try {
      if (target.storagePath) await admin.storage.from('media').remove([target.storagePath]);
    } catch {
      /* still remove catalog entry */
    }
    const next = videos.filter((v) => v.id !== id);
    await saveLegacyFiles(admin, ownerUserId || user.id, next);
    return NextResponse.json({ ok: true, remaining: next.length });
  } catch (e: unknown) {
    console.error('tutorials DELETE:', e);
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}
