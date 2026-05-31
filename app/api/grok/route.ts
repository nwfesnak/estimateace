import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { description } = await request.json();

    if (!description || description.trim().length < 5) {
      return NextResponse.json({ 
        suggestion: "Please type a longer description first!" 
      }, { status: 400 });
    }

    const apiKey = process.env.GROK_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ 
        suggestion: "GROK_API_KEY is not configured on Vercel. Please add it in Settings → Environment Variables." 
      }, { status: 500 });
    }

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "grok-4",           // You can also use "grok-3" if you prefer
        messages: [
          {
            role: "system",
            content: "You are a professional construction estimator. Improve the following line item description to be more clear, detailed, and professional. Return ONLY the improved description, no extra text."
          },
          {
            role: "user",
            content: description
          }
        ],
        temperature: 0.7,
        max_tokens: 250,
      }),
    });

    const data = await response.json();
    const suggestion = data.choices?.[0]?.message?.content?.trim() || "Could not generate improvement.";

    return NextResponse.json({ suggestion });

  } catch (error) {
    console.error("Grok API error:", error);
    return NextResponse.json({ 
      suggestion: "Sorry, Grok AI is temporarily unavailable. Please try again later." 
    }, { status: 500 });
  }
}