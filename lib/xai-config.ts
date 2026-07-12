/**
 * Central xAI model configuration.
 *
 * Defaults use xAI's `-latest` aliases so the provider can roll forward model
 * versions without redeploying hard-coded model IDs (e.g. grok-2-vision-1212).
 *
 * Override in Vercel / .env.local only when you need to pin a specific model:
 *   GROK_MODEL=grok-4.5-latest          (chat + vision fallback)
 *   GROK_CHAT_MODEL=grok-4.5-latest     (quotes, Grok descriptions, translate, address)
 *   GROK_VISION_MODEL=grok-4.5-latest   (AI Quote from Photo)
 *
 * @see https://docs.x.ai/developers/models#model-aliases
 */
export const XAI_DEFAULT_CHAT_MODEL = 'grok-4.5-latest';
export const XAI_DEFAULT_VISION_MODEL = 'grok-4.5-latest';

/** Retired xAI model IDs — auto-migrate to current -latest aliases. */
const DEPRECATED_XAI_MODELS = new Set([
  'grok-2-vision-1212',
  'grok-2-vision-latest',
  'grok-vision-beta',
  'grok-beta',
]);

function resolveXaiModel(
  configured: string | undefined,
  fallback: string,
  kind: 'chat' | 'vision'
): string {
  const trimmed = configured?.trim();
  if (!trimmed) return fallback;

  const normalized = trimmed.toLowerCase();
  if (DEPRECATED_XAI_MODELS.has(normalized)) {
    console.warn(
      `[xai-config] Deprecated ${kind} model "${trimmed}" — using ${fallback}. ` +
        'Remove or update GROK_VISION_MODEL / GROK_CHAT_MODEL / GROK_MODEL in Vercel.'
    );
    return fallback;
  }

  return trimmed;
}

export function getXaiApiKey(): string | undefined {
  return process.env.GROK_API_KEY?.trim() || undefined;
}

export function requireXaiApiKey(): string {
  const key = getXaiApiKey();
  if (!key) {
    throw new Error('GROK_API_KEY is missing');
  }
  return key;
}

/** Text/chat completions (pricing, descriptions, translation, address). */
export function getXaiChatModel(): string {
  const configured =
    process.env.GROK_CHAT_MODEL?.trim() || process.env.GROK_MODEL?.trim();
  return resolveXaiModel(configured, XAI_DEFAULT_CHAT_MODEL, 'chat');
}

/** Vision / image analysis (AI Quote from Photo). */
export function getXaiVisionModel(): string {
  const configured =
    process.env.GROK_VISION_MODEL?.trim() || process.env.GROK_MODEL?.trim();
  return resolveXaiModel(configured, XAI_DEFAULT_VISION_MODEL, 'vision');
}

export function getXaiRuntimeConfig() {
  return {
    chatModel: getXaiChatModel(),
    visionModel: getXaiVisionModel(),
    hasApiKey: Boolean(getXaiApiKey()),
  };
}