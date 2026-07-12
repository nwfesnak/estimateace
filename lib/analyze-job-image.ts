import { getXaiVisionModel, requireXaiApiKey } from '@/lib/xai-config';

export type JobImageAnalysis = {
  scopeDescription: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  estimatedSqft: number | null;
};

function normalizeImageDataUrl(imageBase64: string): string {
  const trimmed = imageBase64.trim();
  if (trimmed.startsWith('data:image/')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

function parseAnalysisJson(aiText: string): JobImageAnalysis | null {
  const stripped = aiText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const jsonMatch = stripped.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const scopeDescription = String(parsed.scopeDescription || parsed.description || '').trim();
    if (scopeDescription.length < 10) return null;

    const confidenceRaw = String(parsed.confidence || 'medium').toLowerCase();
    const confidence =
      confidenceRaw === 'high' || confidenceRaw === 'low' ? confidenceRaw : 'medium';

    const estimatedSqft =
      typeof parsed.estimatedSqft === 'number' && parsed.estimatedSqft > 0
        ? parsed.estimatedSqft
        : null;

    return {
      scopeDescription,
      confidence,
      notes: String(parsed.notes || '').trim(),
      estimatedSqft,
    };
  } catch {
    return null;
  }
}

/**
 * Use Grok vision to turn a job-site photo into an estimatable scope description.
 */
export async function analyzeJobImage(options: {
  imageBase64?: string;
  imageUrl?: string;
  hint?: string;
}): Promise<JobImageAnalysis> {
  const apiKey = requireXaiApiKey();

  const imageUrl = options.imageBase64
    ? normalizeImageDataUrl(options.imageBase64)
    : options.imageUrl?.trim();

  if (!imageUrl) {
    throw new Error('Image is required');
  }

  const hint = options.hint?.trim();
  const prompt = `You are a professional construction estimator reviewing a job-site photo.

Analyze the image and write scope text a contractor can price. Focus on:
- What trade/work is shown (paint, roofing, flooring, drywall, siding, concrete, plumbing, electrical, etc.)
- Visible damage, materials, finishes, or scope of work
- Approximate dimensions or square footage ONLY if reasonably inferable from the photo
- Number of coats, stories, or fixtures if visible

${hint ? `Contractor notes already entered: ${hint}\nUse the photo plus these notes.` : ''}

Return ONLY valid JSON:
{
  "scopeDescription": "Professional estimate line scope with specific features and measurements when known",
  "estimatedSqft": number or null,
  "confidence": "high" | "medium" | "low",
  "notes": "Brief note on what you see in the photo"
}`;

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
      temperature: 0.2,
      max_tokens: 900,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vision API error: ${errorText}`);
  }

  const data = await response.json();
  const aiText = data.choices?.[0]?.message?.content || '';
  const parsed = parseAnalysisJson(aiText);

  if (parsed) {
    if (parsed.estimatedSqft && !/\d+\s*(?:sq\.?\s*ft|sqft|sf)\b/i.test(parsed.scopeDescription)) {
      parsed.scopeDescription = `${parsed.scopeDescription} (~${parsed.estimatedSqft} sq ft)`;
    }
    return parsed;
  }

  const fallback = aiText.trim();
  if (fallback.length >= 20) {
    return {
      scopeDescription: fallback.slice(0, 1200),
      confidence: 'medium',
      notes: 'Parsed from free-form vision response',
      estimatedSqft: null,
    };
  }

  throw new Error('Could not analyze the photo. Try a clearer image or add a short text note.');
}