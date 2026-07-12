import { NextResponse } from 'next/server';
import packageJson from '@/package.json';
import { getXaiRuntimeConfig } from '@/lib/xai-config';

/**
 * Lightweight runtime health check — confirms which model aliases and
 * dependency versions the deployed build is using.
 */
export async function GET() {
  const xai = getXaiRuntimeConfig();

  return NextResponse.json({
    ok: true,
    service: 'estimateace',
    timestamp: new Date().toISOString(),
    runtime: {
      node: process.version,
    },
    xai: {
      chatModel: xai.chatModel,
      visionModel: xai.visionModel,
      apiKeyConfigured: xai.hasApiKey,
      modelPolicy: 'Uses xAI -latest aliases; override via GROK_MODEL / GROK_CHAT_MODEL / GROK_VISION_MODEL',
    },
    dependencies: {
      next: packageJson.dependencies?.next ?? 'unknown',
      react: packageJson.dependencies?.react ?? 'unknown',
      supabase: packageJson.dependencies?.['@supabase/supabase-js'] ?? 'unknown',
    },
  });
}