# AI Receptionist Option B — Phase 2 (live talk)

Live caller ↔ AI using Twilio `<Gather input="speech">` + Grok turns (works on Vercel; no separate WebSocket host).

## Call flow

1. Inbound call → `POST /api/webhooks/twilio/voice`
2. Resolve contractor by `To` number
3. Create `CALL-{CallSid}` session + speak greeting inside `<Gather>`
4. Caller speaks → `POST /api/webhooks/twilio/voice/gather` with `SpeechResult`
5. Grok returns JSON: `{ say, action: continue|transfer|end, lead? }`
6. Tools:
   - **createLead** → Inbox + dashboard Leads (+ SMS/email notify if set)
   - **transferHuman** → `<Dial>` to transfer number
   - **end** → goodbye + hangup
7. Call status `completed` → summarize leftover transcript into a lead if needed

## Why Gather (not ConversationRelay yet)

ConversationRelay needs a long-lived `wss://` server. Vercel serverless does not host that well. Gather + Grok is the same product outcome for v1 (live conversation + leads + transfer). Streaming audio can replace Gather later on Fly/Railway.

## Test

1. Knowledge base filled, receptionist **On**, line enabled  
2. Transfer number saved (optional)  
3. Call your AI line — talk naturally  
4. Ask for a person → should dial transfer number if set  
5. Check **Inbox** / dashboard **Leads** for the call summary  

## Env

Same as Phase 1 + `GROK_API_KEY` (required for live replies).
