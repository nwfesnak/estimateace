/**
 * Turn a contractor's own website into receptionist business facts.
 * Reads the pages they entered, then asks xAI only about that text.
 * If the pages have almost no text, asks xAI to browse that domain only.
 */
import { getXaiApiKey } from '@/lib/xai-config';
import { fetchWebsiteKnowledgeText, resolvePublicWebsiteUrl } from '@/lib/receptionist-website-kb';

const FACTS_MODEL = 'grok-4.7';
const SCRAPE_BUDGET_MS = 12000;
const MIN_PAGE_TEXT = 400;

const SYSTEM_PROMPT = `You write business facts for a contractor's phone receptionist.
Use only facts that appear in the source. Do not invent services, prices, hours, cities, phone numbers, or warranties.
Write a short plain bullet list a caller can be told.
Include, when the source states them: company name, what they do, services, service area, hours, phone, email, pricing or fees, warranty, brands, financing, and anything they say they do not do.
Skip menus, cookie banners, and duplicate lines.
Do not add a title. Start with "- ".
If the source has no useful business facts, reply with exactly NO_FACTS.`;

export type WebsiteFactsResult = {
  facts: string;
  websiteUrl: string;
  source: 'pages' | 'search';
};

function responseText(json: unknown): string {
  const data = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  const chunks: string[] = [];
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) chunks.push(text.trim());
    }
  }
  return chunks.join('\n').trim();
}

function cleanFacts(raw: string): string {
  let text = String(raw || '').trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  if (!text || /^NO_FACTS\b/i.test(text)) return '';
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^no_facts$/i.test(line))
    .map((line) => (line.startsWith('-') || line.startsWith('•') ? line.replace(/^•\s*/, '- ') : `- ${line}`));
  const unique: string[] = [];
  for (const line of lines) {
    if (!unique.some((u) => u.toLowerCase() === line.toLowerCase())) unique.push(line);
  }
  return unique.slice(0, 40).join('\n').slice(0, 4000);
}

async function askXai(body: Record<string, unknown>, timeoutMs: number): Promise<string> {
  const key = getXaiApiKey();
  if (!key) {
    throw new Error('AI is not configured right now. Type the business facts in the box.');
  }
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json && typeof json === 'object' ? (json as { error?: { message?: string } }).error : undefined;
    console.warn('website facts xAI:', res.status, err?.message || '');
    throw new Error('Could not write facts from that website. Try again in a minute.');
  }
  return cleanFacts(responseText(json));
}

async function factsFromPages(websiteUrl: string, pageText: string): Promise<string> {
  return askXai(
    {
      model: FACTS_MODEL,
      store: false,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Website: ${websiteUrl}\n\nPage text:\n${pageText.slice(0, 14000)}`,
        },
      ],
    },
    25000
  );
}

async function factsFromDomainSearch(websiteUrl: string): Promise<string> {
  const hostname = new URL(websiteUrl).hostname.toLowerCase();
  const apex = hostname.replace(/^www\./, '');
  const domains = [...new Set([hostname, apex])].slice(0, 5);
  return askXai(
    {
      model: FACTS_MODEL,
      store: false,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Search only ${websiteUrl} and list the business facts published on that company's website. Do not use other sites.`,
        },
      ],
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: domains },
        },
      ],
    },
    40000
  );
}

export async function buildWebsiteBusinessFacts(rawUrl: string): Promise<WebsiteFactsResult> {
  const websiteUrl = await resolvePublicWebsiteUrl(rawUrl);
  if (!websiteUrl) {
    throw new Error('Enter a public company website, like https://yourcompany.com.');
  }

  const pageText = await fetchWebsiteKnowledgeText(websiteUrl, {
    force: true,
    budgetMs: SCRAPE_BUDGET_MS,
    maxChars: 14000,
    guardRedirects: true,
  });

  let facts = '';
  let source: WebsiteFactsResult['source'] = 'pages';
  if (pageText.trim().length >= MIN_PAGE_TEXT) {
    facts = await factsFromPages(websiteUrl, pageText);
  }
  if (!facts) {
    source = 'search';
    facts = await factsFromDomainSearch(websiteUrl);
  }
  if (!facts) {
    throw new Error(
      'That website did not include enough business details to fill in. Type the facts in the box below.'
    );
  }
  return { facts, websiteUrl, source };
}
