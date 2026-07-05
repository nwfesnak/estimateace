import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { settingsDocId, type StoredAppointment } from '@/lib/appointment-reminders';

async function verifyUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, supabase: null, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.split(' ')[1];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { user: null, supabase: null, error: 'Supabase not configured' };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null, supabase: null, error: 'Unauthorized' };
  }

  return { user, supabase, error: null };
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase, error: authError } = await verifyUser(request);
    if (authError || !user || !supabase) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const appointments = Array.isArray(body.appointments) ? body.appointments as StoredAppointment[] : [];
    const profile = body.profile && typeof body.profile === 'object' ? body.profile : {};

    const { error } = await supabase.from('estimates').upsert({
      id: settingsDocId(user.id),
      user_id: user.id,
      jobName: '__settings__',
      documentType: 'settings',
      items: [],
      profile: {
        ...profile,
        _appointments: appointments,
      },
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error('Appointment sync error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error('Appointment sync error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to sync appointments' },
      { status: 500 }
    );
  }
}