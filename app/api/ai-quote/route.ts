// app/api/ai-quote/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GROK_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ 
        error: 'Missing GROK_API_KEY environment variable on Vercel' 
      }, { status: 500 });
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
        model: 'grok-beta',           // ← safer model
        messages: [
          {
            role: 'system',
            content: `You are a professional contractor cost estimator.
Return ONLY valid JSON:
{
  "unitPrice": number,
  "unit": string,
  "suggestedQty": number,
  "total": number,
  "breakdown": "short explanation",
  "confidence": "high" | "medium" | "low"
}`
          },
          { role: 'user', content: description }
        ],
        temperature: 0.3,
        max_tokens: 600,
      }),
    });

    const rawText = await response.text();   // get raw response for debugging

    if (!response.ok) {
      return NextResponse.json({ 
        error: `xAI API Error ${response.status}: ${rawText}` 
      }, { status: response.status });
    }

    const data = JSON.parse(rawText);
    const aiText = data.choices?.[0]?.message?.content || '';

    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!parsed || typeof parsed.unitPrice !== 'number') {
      return NextResponse.json({ error: 'AI did not return valid JSON' }, { status: 500 });
    }

    return NextResponse.json(parsed);

  } catch (error: any) {
    console.error('Full error:', error);
    return NextResponse.json({ 
      error: error.message || 'Unknown server error' 
    }, { status: 500 });
  }
}