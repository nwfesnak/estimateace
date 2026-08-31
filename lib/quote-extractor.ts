/**
 * AI (and deterministic) scope extraction for template quoting.
 * Returns templateId + facts only — never invents prices.
 */
import { getXaiApiKey, getXaiQuoteModel } from './xai-config';
import {
  QUOTE_TEMPLATES,
  detectTemplateId,
  extractFactsFromDescription,
  getTemplate,
  missingRequiredFacts,
  type QuoteFactKey,
  type QuoteFacts,
} from './quote-templates';

export type ExtractedScope = {
  templateId: string;
  templateLabel: string;
  confidence: 'high' | 'medium' | 'low';
  facts: QuoteFacts;
  missingFacts: QuoteFactKey[];
  scopeSummary: string;
  source: 'deterministic' | 'llm' | 'llm+merge';
};

function mergeFacts(base: QuoteFacts, overlay: QuoteFacts): QuoteFacts {
  const out: QuoteFacts = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (k === 'notes') {
      if (v) out.notes = String(v);
      continue;
    }
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) (out as any)[k] = n;
  }
  return out;
}

export function extractScopeDeterministic(description: string): ExtractedScope {
  const templateId = detectTemplateId(description);
  const t = getTemplate(templateId);
  const facts = extractFactsFromDescription(description, templateId);
  const missing = missingRequiredFacts(templateId, facts);
  return {
    templateId,
    templateLabel: t?.label || templateId,
    confidence: missing.length ? 'medium' : 'high',
    facts,
    missingFacts: missing,
    scopeSummary: `${t?.label || templateId}: ${description.trim().slice(0, 160)}`,
    source: 'deterministic',
  };
}

async function callExtractorLlm(description: string): Promise<Partial<ExtractedScope> | null> {
  const apiKey = getXaiApiKey();
  if (!apiKey) return null;

  const catalog = QUOTE_TEMPLATES.filter((t) => t.id !== 'unit_task')
    .map((t) => `- ${t.id}: ${t.label} (needs: ${t.requiredFacts.join(', ') || 'none'})`)
    .join('\n');

  const model = getXaiQuoteModel();
  try {
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        reasoning_effort: 'low',
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content: `You classify residential contractor line items into a pricing TEMPLATE and extract FACTS only.
NEVER invent prices, gallons, hours, labor rates, or $/SF.
When a description mentions both a small wall (e.g. 240 SF) AND a home floor area (e.g. 1,567 SF home / bedrooms), use the HOME FLOOR SF for whole-home paint templates.
If painting all interior walls of a home, templateId = paint_interior_whole_home.
Fence / gutter / pipe / duct / trim jobs use linearFeet (LF), not floorSqft.
Landscaping / sod / mulch / irrigation use areaSqft.
Plumbing fixtures (toilet, faucet) → plumbing_fixture. Water/drain line runs → plumbing_water_line.
Outlets/fans/lights → electrical_fixture. New circuits/rewire → electrical_circuit.
HVAC systems → hvac_system. Duct runs → hvac_duct.
NEVER invent prices.

Templates:
${catalog}
- unit_task: miscellaneous single fixture/hardware job

Return ONLY JSON:
{
  "templateId": "paint_interior_whole_home",
  "confidence": "high",
  "facts": { "floorSqft": 1567, "wallSqft": null, "coats": 2, "ceilingFt": 8, "areaSqft": null, "roofSqft": null, "linearFeet": null, "quantity": 1 },
  "scopeSummary": "short scope"
}`,
          },
          { role: 'user', content: description.trim() },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const raw = String(data?.choices?.[0]?.message?.content || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    const templateId = String(parsed.templateId || '').trim();
    if (!templateId || !getTemplate(templateId)) return null;
    const facts = (parsed.facts || {}) as QuoteFacts;
    return {
      templateId,
      confidence: parsed.confidence === 'low' || parsed.confidence === 'medium' ? parsed.confidence : 'high',
      facts,
      scopeSummary: String(parsed.scopeSummary || '').slice(0, 300),
      source: 'llm',
    };
  } catch {
    return null;
  }
}

/**
 * Extract template + facts. Merges LLM with deterministic parse.
 * User-provided factsOverride always wins.
 */
export async function extractQuoteScope(input: {
  description: string;
  factsOverride?: QuoteFacts;
  templateIdOverride?: string;
  skipLlm?: boolean;
}): Promise<ExtractedScope> {
  const description = String(input.description || '').trim();
  const deterministic = extractScopeDeterministic(description);

  let templateId = input.templateIdOverride || deterministic.templateId;
  let facts = { ...deterministic.facts };
  let confidence = deterministic.confidence;
  let scopeSummary = deterministic.scopeSummary;
  let source: ExtractedScope['source'] = 'deterministic';

  if (!input.skipLlm && !input.templateIdOverride) {
    const llm = await callExtractorLlm(description);
    if (llm?.templateId) {
      templateId = llm.templateId;
      facts = mergeFacts(facts, llm.facts || {});
      confidence = llm.confidence || confidence;
      if (llm.scopeSummary) scopeSummary = llm.scopeSummary;
      source = 'llm+merge';
    }
  }

  if (input.factsOverride) {
    facts = mergeFacts(facts, input.factsOverride);
  }
  if (input.templateIdOverride) {
    templateId = input.templateIdOverride;
  }

  // Re-extract coats/floor from text if still missing after merge
  const again = extractFactsFromDescription(description, templateId);
  facts = mergeFacts(again, facts);

  const t = getTemplate(templateId);
  const missing = missingRequiredFacts(templateId, facts);

  return {
    templateId,
    templateLabel: t?.label || templateId,
    confidence: missing.length ? 'medium' : confidence,
    facts,
    missingFacts: missing,
    scopeSummary,
    source,
  };
}
