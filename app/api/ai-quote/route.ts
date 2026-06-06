// app/api/ai-quote/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GROK_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing GROK_API_KEY' }, { status: 500 });
    }

    const { description } = await request.json();
    if (!description?.trim()) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 });
    }

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3',
        messages: [
          {
            role: 'system',
            content: `You are a professional contractor cost estimator.
Research current 2026 online market prices.

For the line item below, return ONLY valid JSON:

{
  "suggestedDescription": "Clean, professional, customer-friendly description (make it sound high-quality and clear)",
  "unitPrice": number,
  "unit": string,
  "suggestedQty": number,
  "total": number,
  "breakdown": "Short 1-2 sentence explanation with sources or market reasoning",
  "confidence": "high" | "medium" | "low"
}`
          },
          { role: 'user', content: description }
        ],
        temperature: 0.3,
        max_tokens: 900,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: `xAI API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const aiText = data.choices?.[0]?.message?.content || '';

    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!parsed || typeof parsed.unitPrice !== 'number') {
      return NextResponse.json({ error: 'AI returned invalid format' }, { status: 500 });
    }

    return NextResponse.json(parsed);
  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}