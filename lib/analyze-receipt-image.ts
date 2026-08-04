import { getXaiVisionModel, requireXaiApiKey } from '@/lib/xai-config';

export type ReceiptScanResult = {
  total: number;
  vendor: string;
  date: string | null;
  currency: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  lineItemsSummary: string;
};

function normalizeImageDataUrl(imageBase64: string): string {
  const trimmed = imageBase64.trim();
  if (trimmed.startsWith('data:image/')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

function parseMoney(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value * 100) / 100;
  }
  const s = String(value ?? '')
    .replace(/[^0-9.,\-]/g, '')
    .replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function parseScanJson(aiText: string): ReceiptScanResult | null {
  const stripped = aiText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const total = parseMoney(parsed.total ?? parsed.amount ?? parsed.grandTotal);
    if (!(total > 0)) return null;

    const confidenceRaw = String(parsed.confidence || 'medium').toLowerCase();
    const confidence =
      confidenceRaw === 'high' || confidenceRaw === 'low' ? confidenceRaw : 'medium';

    let date: string | null = null;
    const rawDate = String(parsed.date || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) date = rawDate;
    else if (rawDate) {
      const d = new Date(rawDate);
      if (!Number.isNaN(d.getTime())) date = d.toISOString().slice(0, 10);
    }

    return {
      total,
      vendor: String(parsed.vendor || parsed.merchant || parsed.store || '').trim().slice(0, 120),
      date,
      currency: String(parsed.currency || 'USD').trim().slice(0, 8) || 'USD',
      confidence,
      notes: String(parsed.notes || '').trim().slice(0, 500),
      lineItemsSummary: String(parsed.lineItemsSummary || parsed.items || '').trim().slice(0, 500),
    };
  } catch {
    return null;
  }
}

/**
 * Use Grok vision to read a receipt photo and extract the TOTAL amount.
 */
export async function analyzeReceiptImage(options: {
  imageBase64?: string;
  imageUrl?: string;
}): Promise<ReceiptScanResult> {
  const apiKey = requireXaiApiKey();

  const imageUrl = options.imageBase64
    ? normalizeImageDataUrl(options.imageBase64)
    : options.imageUrl?.trim();

  if (!imageUrl) {
    throw new Error('Receipt image is required');
  }

  const prompt = `You are reading a store / gas / materials RECEIPT photo for a contractor expense tracker.

Find the FINAL amount the customer paid (grand total / total / amount due / balance paid).
Prefer the largest final total, not subtotal, tax alone, or change due.

Also extract merchant/vendor name and purchase date when visible.

Return ONLY valid JSON:
{
  "total": 12.34,
  "vendor": "Store name or blank",
  "date": "YYYY-MM-DD or null",
  "currency": "USD",
  "confidence": "high" | "medium" | "low",
  "notes": "Where you found the total (e.g. bottom TOTAL line)",
  "lineItemsSummary": "Brief list of main items if readable"
}

Rules:
- total must be a number (dollars), not a string
- If multiple totals exist, use the final amount charged
- If unreadable, still return best guess with confidence "low"`;

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: getXaiVisionModel(),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageUrl, detail: 'high' },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 600,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Receipt vision API error: ${errorText}`);
  }

  const data = await response.json();
  const aiText = data.choices?.[0]?.message?.content || '';
  const parsed = parseScanJson(aiText);
  if (parsed) return parsed;

  // Fallback: first $ amount in free text that looks like a total
  const moneyMatch = aiText.match(/(?:total|amount|due|paid)[^\d$]{0,20}\$?\s*(\d{1,6}(?:\.\d{2})?)/i)
    || aiText.match(/\$\s*(\d{1,6}\.\d{2})/);
  if (moneyMatch) {
    const total = parseMoney(moneyMatch[1]);
    if (total > 0) {
      return {
        total,
        vendor: '',
        date: null,
        currency: 'USD',
        confidence: 'low',
        notes: 'Parsed total from free-form vision text',
        lineItemsSummary: '',
      };
    }
  }

  throw new Error('Could not read a total on this receipt. Enter the amount manually.');
}
