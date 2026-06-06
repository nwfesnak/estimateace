// app/api/ai-quote/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const apiKey = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  
  if (!apiKey) {
    console.error('❌ Missing GROK_API_KEY or XAI_API_KEY in environment variables');
    return NextResponse.json(
      { error: 'AI service not configured (missing API key)' },
      { status: 500 }
    );
  }

  try {
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
        model: 'grok-4.3',           // ← Updated to current model (2026)
        messages: [
          {
            role: 'system',
            content: `You are a professional contractor cost estimator with 2026 real-time market data.
Research current online prices (Home Depot, Lowe's, supplier sites, labor rates, etc.) for the exact line item below.

Return ONLY a valid JSON object in this exact format (no extra text, no markdown):

{
  "unitPrice": number,
  "unit": string,
  "suggestedQty": number,
  "total": number,
  "breakdown": "short 1-2 sentence explanation with sources/market average",
  "confidence": "high" | "medium" | "low"
}`
          },
          {
            role: 'user',
            content: description
          }
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('xAI API error:', response.status, errorText);
      throw new Error(`xAI API error ${response.status}`);
    }

    const data = await response.json();
    const aiText = data.choices?.[0]?.message?.content || '';

    // Safely extract JSON
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!parsed || typeof parsed.unitPrice !== 'number') {
      return NextResponse.json({ error: 'AI returned invalid quote format' }, { status: 500 });
    }

    return NextResponse.json(parsed);
  } catch (error: any) {
    console.error('AI Quote full error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to contact AI service' },
      { status: 500 }
    );
  }
}