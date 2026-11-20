import { getXaiChatModel, reasoningEffortFor } from '@/lib/xai-config';

export const XAI_CHAT_COMPLETIONS_URL = 'https://api.x.ai/v1/chat/completions';

export function buildXaiChatBody(opts: {
  model: string;
  systemPrompt: string;
  userContent: string;
  maxTokens: number;
  temperature?: number;
}): Record<string, unknown> {
  const model = String(opts.model || '').trim() || getXaiChatModel();
  const effort = reasoningEffortFor(model);
  return {
    model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userContent },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

export function extractChatText(data: unknown): { text: string; finish: string | null } {
  const choice = (data as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> })
    ?.choices?.[0];
  return {
    text: String(choice?.message?.content || '').trim(),
    finish: choice?.finish_reason ? String(choice.finish_reason) : null,
  };
}

export function translationFromEmptyContent(finish: string | null): string {
  if (finish === 'length') {
    return 'Translation was cut off. Try a shorter description.';
  }
  return 'Could not generate a translation. Please try again.';
}

export function isAbortError(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  return name === 'TimeoutError' || name === 'AbortError';
}

/** User-facing message for a failed /api/translate response or a thrown error. */
export function translateFailureMessage(opts: {
  ok?: boolean;
  status?: number;
  data?: { error?: unknown; translatedText?: unknown };
  err?: unknown;
}): string {
  if (opts.err) {
    if (isAbortError(opts.err)) return 'Translation timed out. Please try again.';
    const msg = opts.err instanceof Error ? opts.err.message : String(opts.err || '');
    return msg.trim() || 'Translation service temporarily unavailable.';
  }
  const apiError = typeof opts.data?.error === 'string' ? opts.data.error.trim() : '';
  if (opts.ok === false || (opts.status && opts.status >= 400)) {
    if (opts.status === 401) return 'Please sign in to translate descriptions.';
    if (opts.status === 429) return apiError || 'Too many translations. Please wait a moment and try again.';
    if (opts.status === 504) return apiError || 'Translation timed out. Please try again.';
    return apiError || `Translation failed (${opts.status || 'error'}). Please try again.`;
  }
  const text = typeof opts.data?.translatedText === 'string' ? opts.data.translatedText.trim() : '';
  if (!text) return 'No translation came back. Please try again.';
  return '';
}
