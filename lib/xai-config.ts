/**
 * Central xAI model configuration.
 *
 * SuperGrok (app.x.ai / grok.com) uses xAI's flagship chat models.
 * AI Price Quote should use the same flagship tier via the API — not a
 * weaker model + heavy local engines that rewrite SuperGrok-quality answers.
 *
 * Override in Vercel / .env.local:
 *   GROK_QUOTE_MODEL=grok-4.6           (AI estimates — SuperGrok-class)
 *   GROK_CHAT_MODEL=grok-4.6            (general chat)
 *   GROK_MODEL=grok-4.6                 (fallback for chat/vision/quote)
 *   GROK_VISION_MODEL=grok-4.6
 *
 * @see https://docs.x.ai/developers/models
 */
/** Flagship — same class SuperGrok uses for high-quality estimates. */
export const XAI_DEFAULT_CHAT_MODEL = 'grok-4.6';
export const XAI_DEFAULT_VISION_MODEL = 'grok-4.6';
/** Dedicated default for AI Price Quote (SuperGrok-style contractor estimates). */
export const XAI_DEFAULT_QUOTE_MODEL = 'grok-4.6';
/** Grok Imagine — image generation / edit (job renderings). */
export const XAI_DEFAULT_IMAGE_MODEL = 'grok-imagine-image-quality';

/** Retired xAI model IDs — auto-migrate to current flagship. */
const DEPRECATED_XAI_MODELS = new Set([
  'grok-2-vision-1212',
  'grok-2-vision-latest',
  'grok-vision-beta',
  'grok-beta',
  'grok-4.5-latest',
  'grok-4.5',
]);

function resolveXaiModel(
  configured: string | undefined,
  fallback: string,
  kind: 'chat' | 'vision' | 'quote'
): string {
  const trimmed = configured?.trim();
  if (!trimmed) return fallback;

  const normalized = trimmed.toLowerCase();
  if (DEPRECATED_XAI_MODELS.has(normalized)) {
    console.warn(
      `[xai-config] Deprecated ${kind} model "${trimmed}" — using ${fallback}. ` +
        'Update GROK_QUOTE_MODEL / GROK_CHAT_MODEL / GROK_MODEL in Vercel to grok-4.6.'
    );
    return fallback;
  }

  return trimmed;
}

export function getXaiApiKey(): string | undefined {
  return process.env.GROK_API_KEY?.trim() || process.env.XAI_API_KEY?.trim() || undefined;
}

export function requireXaiApiKey(): string {
  const key = getXaiApiKey();
  if (!key) {
    throw new Error('GROK_API_KEY is missing');
  }
  return key;
}

/** Text/chat completions (descriptions, translation, address). */
export function getXaiChatModel(): string {
  const configured =
    process.env.GROK_CHAT_MODEL?.trim() || process.env.GROK_MODEL?.trim();
  return resolveXaiModel(configured, XAI_DEFAULT_CHAT_MODEL, 'chat');
}

/**
 * AI Price Quote model — SuperGrok-class flagship.
 * Prefer GROK_QUOTE_MODEL so quotes can stay on the best model independently.
 */
export function getXaiQuoteModel(): string {
  const configured =
    process.env.GROK_QUOTE_MODEL?.trim() ||
    process.env.GROK_CHAT_MODEL?.trim() ||
    process.env.GROK_MODEL?.trim();
  return resolveXaiModel(configured, XAI_DEFAULT_QUOTE_MODEL, 'quote');
}

/** Vision / image analysis (AI Quote from Photo). */
export function getXaiVisionModel(): string {
  const configured =
    process.env.GROK_VISION_MODEL?.trim() || process.env.GROK_MODEL?.trim();
  return resolveXaiModel(configured, XAI_DEFAULT_VISION_MODEL, 'vision');
}

/** Image generation / edit (AI completed-job renderings). */
export function getXaiImageModel(): string {
  const configured = process.env.GROK_IMAGE_MODEL?.trim();
  if (configured) return configured;
  return XAI_DEFAULT_IMAGE_MODEL;
}

export function getXaiRuntimeConfig() {
  return {
    chatModel: getXaiChatModel(),
    quoteModel: getXaiQuoteModel(),
    visionModel: getXaiVisionModel(),
    imageModel: getXaiImageModel(),
    hasApiKey: Boolean(getXaiApiKey()),
  };
}