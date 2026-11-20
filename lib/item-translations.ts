/**
 * Internal line-item translations (estimate editor + crew).
 * These fields live on estimates.items / archive-est items JSONB.
 * They must never be sent to clients (approval page, PDFs, emails, public views).
 */

export const ITEM_TRANSLATION_KEYS = [
  'translation',
  'translationLang',
  'translatedAt',
  'translationSource',
] as const;

export type ItemTranslationKey = (typeof ITEM_TRANSLATION_KEYS)[number];

export type ItemTranslationFields = {
  translation?: string;
  translationLang?: string;
  translatedAt?: string;
  /** Description text that was translated; used to detect later edits. */
  translationSource?: string;
};

export function itemTranslationText(item: { translation?: unknown } | null | undefined): string {
  return String(item?.translation || '').trim();
}

export function itemHasTranslation(item: { translation?: unknown } | null | undefined): boolean {
  return Boolean(itemTranslationText(item));
}

export function isItemTranslationStale(item: {
  description?: unknown;
  translation?: unknown;
  translationSource?: unknown;
} | null | undefined): boolean {
  if (!itemHasTranslation(item)) return false;
  return String(item?.translationSource ?? '') !== String(item?.description ?? '');
}

export function withoutItemTranslation<T>(item: T): T {
  if (!item || typeof item !== 'object') return item;
  const next = { ...(item as Record<string, unknown>) };
  let changed = false;
  for (const key of ITEM_TRANSLATION_KEYS) {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  }
  return (changed ? next : item) as T;
}

export function withItemTranslation<T extends Record<string, unknown>>(
  item: T,
  text: string,
  lang: string,
  sourceDescription?: unknown,
  at = new Date().toISOString()
): T & ItemTranslationFields {
  const translation = String(text || '').trim();
  if (!translation) return withoutItemTranslation(item) as T & ItemTranslationFields;
  return {
    ...item,
    translation,
    translationLang: String(lang || '').trim() || 'und',
    translatedAt: at,
    translationSource: String(sourceDescription ?? item.description ?? ''),
  };
}

export function stripItemTranslations<T>(items: T[] | null | undefined): T[] {
  return (items || []).map((item) => withoutItemTranslation(item));
}

/** Drop translation fields from a document-like payload that has an `items` array (or JSON string). */
export function stripTranslationsFromDocument<T>(doc: T): T {
  if (!doc || typeof doc !== 'object') return doc;
  const rec = doc as Record<string, unknown>;
  if (!('items' in rec)) return doc;
  const raw = rec.items;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { ...rec, items: JSON.stringify(stripItemTranslations(parsed)) } as T;
      }
    } catch {
      return doc;
    }
    return doc;
  }
  if (!Array.isArray(raw)) return doc;
  return { ...rec, items: stripItemTranslations(raw) } as T;
}

export function clientSafeLineItem(item: any, index = 0): Record<string, unknown> {
  const src = withoutItemTranslation(item || {});
  return {
    id: src.id ?? `idx-${index}`,
    description: String(src.description || 'Line item').slice(0, 200),
    qty: Number(src.qty) || 0,
    unit: src.unit != null ? String(src.unit).slice(0, 40) : undefined,
    price: Number(src.price) || 0,
    total: Number(src.total) || Number(src.qty || 0) * Number(src.price || 0),
    optional: src.optional === true,
    clientSelected: src.clientSelected === true,
  };
}
