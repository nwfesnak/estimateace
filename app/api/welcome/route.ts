import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  PLATFORM_TUTORIALS_ROW_ID,
  isPlatformAdminEmail,
} from '@/lib/platform-tutorials';
import { normalizeWelcomeVideo, resolveWelcomeEmbed } from '@/lib/welcome-video';

export const dynamic = 'force-dynamic';

async function loadWelcomeProfile(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>) {
  const { data } = await admin
    .from('estimates')
    .select('profile, user_id')
    .eq('id', PLATFORM_TUTORIALS_ROW_ID)
    .maybeSingle();
  const profile = (data?.profile || {}) as any;
  return {
    profile,
    ownerUserId: (data?.user_id as string) || null,
    welcome: normalizeWelcomeVideo(profile.welcomeVideo || profile.signupWelcome || {}),
  };
}

/**
 * GET — public (no auth). Returns unlisted signup welcome video config.
 * Env fallback: WELCOME_VIDEO_URL or NEXT_PUBLIC_WELCOME_VIDEO_URL
 */
export async function GET() {
  try {
    const envUrl = (
      process.env.WELCOME_VIDEO_URL ||
      process.env.NEXT_PUBLIC_WELCOME_VIDEO_URL ||
      ''
    ).trim();

    const admin = getSupabaseAdmin();
    let welcome = normalizeWelcomeVideo({
      videoUrl: envUrl,
      title: process.env.WELCOME_VIDEO_TITLE || 'Welcome to EstimateAce',
      description:
        process.env.WELCOME_VIDEO_DESCRIPTION ||
        'A quick walkthrough of EstimateAce — estimates, AI quoting, invoices, and getting paid.',
    });

    if (admin) {
      try {
        const loaded = await loadWelcomeProfile(admin);
        if (loaded.welcome.videoUrl) {
          welcome = loaded.welcome;
        } else if (envUrl && !loaded.welcome.videoUrl) {
          welcome = { ...welcome, videoUrl: envUrl };
        }
      } catch {
        /* use env / defaults */
      }
    }

    const embed = resolveWelcomeEmbed(welcome.videoUrl);

    return NextResponse.json({
      ok: true,
      shareUrl: 'https://app.estimateace.com/welcome',
      title: welcome.title,
      description: welcome.description,
      videoUrl: welcome.videoUrl,
      embed,
      updatedAt: welcome.updatedAt || null,
    });
  } catch (e: any) {
    console.error('welcome GET:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * POST — platform admin only. Body: { videoUrl, title?, description? }
 * Saves onto PLATFORM-TUTORIALS profile.welcomeVideo (keeps existing tutorial videos).
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    if (!isPlatformAdminEmail(user.email)) {
      return NextResponse.json(
        { error: 'Only the EstimateAce owner can set the signup welcome video.' },
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

    const body = await request.json().catch(() => ({}));
    const videoUrl = String(body.videoUrl || body.url || '').trim();
    const title = String(body.title || 'Welcome to EstimateAce').trim().slice(0, 200);
    const description = String(body.description || '').trim().slice(0, 4000);

    if (videoUrl && !/^https?:\/\//i.test(videoUrl)) {
      return NextResponse.json(
        { error: 'Video URL must start with https:// (YouTube, Loom, Vimeo, or direct MP4 link).' },
        { status: 400 }
      );
    }

    const { profile, ownerUserId } = await loadWelcomeProfile(admin);
    const welcomeVideo = normalizeWelcomeVideo({
      videoUrl,
      title: title || 'Welcome to EstimateAce',
      description:
        description ||
        'A quick walkthrough of EstimateAce — estimates, AI quoting, invoices, and getting paid.',
      updatedAt: new Date().toISOString(),
    });

    const nextProfile = {
      ...profile,
      videos: Array.isArray(profile.videos) ? profile.videos : [],
      welcomeVideo,
    };

    const { error } = await admin.from('estimates').upsert(
      {
        id: PLATFORM_TUTORIALS_ROW_ID,
        user_id: ownerUserId || user.id,
        invoiceNumber: PLATFORM_TUTORIALS_ROW_ID,
        jobName: 'EstimateAce video tutorials',
        documentType: 'estimate',
        items: [],
        profile: nextProfile,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      shareUrl: 'https://app.estimateace.com/welcome',
      welcome: welcomeVideo,
      embed: resolveWelcomeEmbed(welcomeVideo.videoUrl),
    });
  } catch (e: any) {
    console.error('welcome POST:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
