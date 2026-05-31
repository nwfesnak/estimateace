import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { description } = await req.json();

    if (!process.env.GROK_API_KEY) {
      return NextResponse.json({ suggestion: 'ERROR: GROK_API_KEY is missing in .env.local' });
    }

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-4.3',
        messages: [
          {
            role: 'system',
            content: 'You are an expert construction estimator. Improve this line item description to be more professional, detailed, and client-friendly. Always return at least 2 full sentences.'
          },
          { role: 'user', content: description || 'No description provided' }
        ],
        temperature: 0.7,
        max_tokens: 300
      }),
    });

    const data = await response.json();
    const suggestion = data.choices?.[0]?.message?.content?.trim() || '';

    return NextResponse.json({ suggestion });
  } catch (error: any) {
    console.error('Grok API Error:', error);
    return NextResponse.json({ suggestion: 'Could not reach Grok AI. Check your GROK_API_KEY.' });
  }
}