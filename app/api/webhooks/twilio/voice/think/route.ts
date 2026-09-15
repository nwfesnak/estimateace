import { NextRequest } from 'next/server';
import {
  loadCallSession,
  saveCallSession,
  scriptComplete,
  transcriptToText,
  type CallStage,
} from '@/lib/receptionist-call-session';
import {
  looksLikePersonName,
  runReceptionistVoiceTurn,
} from '@/lib/receptionist-voice-agent';
import { formatPhoneForSpeech } from '@/lib/receptionist-twiml';
import { appendReceptionistLead, formatLeadSummary } from '@/lib/receptionist-leads';
import {
  sayGatherTwiml,
  sayHangupTwiml,
  transferTwiml,
  twimlXmlResponse,
  VOICE_GATHER_PATH,
} from '@/lib/receptionist-twiml';
import { formatPhoneE164 } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;
export const runtime = 'nodejs';

const MAX_TURNS = 14;

/**
 * POST /api/webhooks/twilio/voice/think
 * Staged script turn after gather stashed pendingCallerText.
 */
export async function POST(request: NextRequest) {
  try {
    let callSid = request.nextUrl.searchParams.get('CallSid') || '';
    try {
      const form = await request.formData();
      if (!callSid) callSid = String(form.get('CallSid') || '');
    } catch {
      /* query param only */
    }
    callSid = callSid.trim();

    console.info('voice think', { callSid: callSid.slice(0, 34) });

    const session = callSid ? await loadCallSession(callSid) : null;
    if (!session) {
      return twimlXmlResponse(
        sayGatherTwiml({
          say: 'Thanks for calling. What are you calling about today?',
          gatherActionUrl: VOICE_GATHER_PATH,
        })
      );
    }

    const callerText = String(session.pendingCallerText || '').trim();
    session.pendingCallerText = '';

    if (!callerText) {
      const stage = session.callStage || 'need';
      const prompt =
        stage === 'name'
          ? 'Who am I speaking with?'
          : stage === 'phone'
            ? 'Is this the best number to call you back on?'
            : stage === 'anything_else'
              ? "Anything else you'd like to add, or anything else we can help with today?"
              : stage === 'techs_sms'
                ? 'Are you okay with us texting you as well?'
                : 'What are you calling about today?';
      return twimlXmlResponse(
        sayGatherTwiml({
          say: prompt,
          gatherActionUrl: VOICE_GATHER_PATH,
        })
      );
    }

    if (/^Pressed 0$/i.test(callerText)) {
      const transferE164 = formatPhoneE164(session.transferNumber || '') || '';
      if (transferE164) {
        return twimlXmlResponse(
          transferTwiml({
            say: 'Connecting you now.',
            transferTo: transferE164,
            callerId: session.to || undefined,
          })
        );
      }
    }

    session.transcript.push({ role: 'caller', text: callerText });
    session.turn = (session.turn || 0) + 1;

    if (session.turn > MAX_TURNS) {
      const bye = `Thanks so much for calling ${session.businessName || 'us'}. We'll be in contact with you as soon as possible. Goodbye!`;
      session.transcript.push({ role: 'agent', text: bye });
      session.callStage = 'thanks';
      try {
        await saveCallSession(session);
      } catch {
        /* ignore */
      }
      return twimlXmlResponse(sayHangupTwiml(bye));
    }

    const transferE164 = formatPhoneE164(session.transferNumber || '') || '';

    let result;
    try {
      result = await runReceptionistVoiceTurn({
        businessName: session.businessName,
        knowledgeBase: session.knowledgeBase,
        websiteUrl: session.websiteUrl,
        websiteText: session.websiteText,
        greetingStyle: session.greeting,
        languages: session.languages,
        urgentKeywords: session.urgentKeywords,
        callerPhone: session.from,
        transcript: session.transcript,
        callerMessage: callerText,
        transferAvailable: Boolean(transferE164),
        collectedName: session.collectedName,
        collectedPhone: session.collectedPhone,
        collectedAddress: session.collectedAddress,
        collectedNotes: session.collectedNotes,
        callStage: (session.callStage as CallStage) || 'need',
        smsOk: session.smsOk,
      });
    } catch (e) {
      console.error('voice think staged:', e);
      const stage = (session.callStage as CallStage) || 'need';
      result = {
        say:
          stage === 'need'
            ? 'Thanks for calling — what are you calling about today?'
            : stage === 'name'
              ? 'Happy to help — who am I speaking with?'
              : stage === 'phone'
                ? 'Got it — is this the best number to call you back on?'
                : stage === 'anything_else'
                  ? "Anything else you'd like to add, or anything else we can help with today?"
                  : stage === 'techs_sms'
                    ? 'Are you okay with us texting you as well?'
                    : `Thanks so much for calling ${session.businessName || 'us'}. We'll be in contact with you as soon as possible. Goodbye!`,
        action: (stage === 'thanks' || stage === 'techs_sms' ? 'end' : 'continue') as
          | 'continue'
          | 'end',
        lead: {
          name: session.collectedName || '',
          phone: session.collectedPhone || '',
          address: session.collectedAddress || '',
          notes: session.collectedNotes || callerText,
        },
        callStage: stage,
        smsOk: session.smsOk,
      };
    }

    // Persist stage + SMS preference + website text from agent
    if (result.callStage) {
      session.callStage = result.callStage;
    }
    if (result.smsOk === true || result.smsOk === false) {
      session.smsOk = result.smsOk;
    }
    if (result.websiteText && !session.websiteText) {
      session.websiteText = String(result.websiteText).slice(0, 8000);
    }

    // Merge collected contact fields from this turn
    if (result.lead) {
      if (result.lead.name) session.collectedName = String(result.lead.name).trim();
      if (result.lead.phone) session.collectedPhone = String(result.lead.phone).trim();
      if (result.lead.address) session.collectedAddress = String(result.lead.address).trim();
      const noteBits = [
        result.lead.jobType ? String(result.lead.jobType).trim() : '',
        result.lead.notes ? String(result.lead.notes).trim() : '',
        result.lead.preferredTime ? `Preferred: ${String(result.lead.preferredTime).trim()}` : '',
      ].filter(Boolean);
      if (noteBits.length) {
        const prev = String(session.collectedNotes || '').trim();
        // Prefer the agent's merged notes string when present
        const fromNotes = result.lead.notes ? String(result.lead.notes).trim() : '';
        if (fromNotes && fromNotes.length >= prev.length) {
          session.collectedNotes = fromNotes.slice(0, 1500);
        } else {
          const merged = [...new Set([prev, ...noteBits].filter(Boolean))].join(' | ');
          session.collectedNotes = merged.slice(0, 1500);
        }
      }
    }

    // Break the name loop: Twilio STT often returns lowercase names
    if (!session.collectedName && looksLikePersonName(callerText)) {
      session.collectedName = callerText
        .replace(/[.,!?]/g, '')
        .trim()
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ')
        .slice(0, 120);
      if (result.lead) result.lead.name = session.collectedName;
    }

    let speak = String(result.say || '').trim();
    if (!speak || speak.startsWith('{') || speak.includes('"action"')) {
      const first = (session.collectedName || '').split(/\s+/)[0];
      const hi = first ? `${first}, ` : '';
      const stage = session.callStage || 'need';
      speak =
        stage === 'need'
          ? 'What are you calling about today?'
          : stage === 'name'
            ? 'Happy to help — who am I speaking with?'
            : stage === 'phone'
              ? `${hi}is ${session.from ? formatPhoneForSpeech(session.from) : 'this number'} the best one to call you back on?`
              : stage === 'anything_else'
                ? `Anything else you'd like to add, or anything else we can help with today?`
                : stage === 'techs_sms'
                  ? `All of our technicians are helping other customers right now, so we'll call you back as soon as we can. Are you okay with us texting you as well?`
                  : `Thanks so much for calling ${session.businessName || 'us'}. We'll be in contact with you as soon as possible. Goodbye!`;
    }

    // Rewrite any raw +1… / long digit runs so <Say> speaks digits
    speak = speak.replace(/\+?1?\D*(\d{3})\D*(\d{3})\D*(\d{4})\b/g, (_m, a, b, c) =>
      formatPhoneForSpeech(`${a}${b}${c}`)
    );
    speak = speak.slice(0, 420);

    session.transcript.push({ role: 'agent', text: speak });

    const complete = scriptComplete(session);
    // Do not require address; only hang up when script is complete (or agent ends after SMS)
    if (result.action === 'end' && !complete && session.callStage !== 'thanks') {
      // Soft guard: if agent tried to end early, keep gathering
      result.action = 'continue';
      const stage = session.callStage || 'need';
      const first = (session.collectedName || '').split(/\s+/)[0];
      const hi = first ? `${first}, ` : '';
      if (!session.collectedNotes) {
        speak = 'Before we wrap up — what are you calling about today?';
        session.callStage = 'need';
      } else if (!session.collectedName) {
        speak = 'Before we wrap up — who am I speaking with?';
        session.callStage = 'name';
      } else if (!session.collectedPhone) {
        speak = `${hi}what's the best number to reach you?`;
        session.callStage = 'phone';
      } else if (session.smsOk !== true && session.smsOk !== false) {
        speak =
          `All of our technicians are helping other customers right now, so we'll call you back as soon as we can. Are you okay with us texting you as well?`;
        session.callStage = 'techs_sms';
      }
    }

    // Allow end when stage is thanks (final goodbye) even if smsOk race
    if (session.callStage === 'thanks') {
      result.action = 'end';
      if (session.smsOk !== true && session.smsOk !== false) {
        session.smsOk = true;
      }
    }

    // Save / update lead once we have useful fields
    try {
      if (
        session.collectedName ||
        session.collectedPhone ||
        session.collectedAddress ||
        session.collectedNotes
      ) {
        const done = scriptComplete(session) || session.callStage === 'thanks';
        const summary = formatLeadSummary({
          name: session.collectedName,
          phone: session.collectedPhone || session.from,
          address: session.collectedAddress,
          notes: [
            session.collectedNotes || '',
            session.smsOk === true
              ? 'SMS OK: yes'
              : session.smsOk === false
                ? 'SMS OK: no'
                : '',
          ]
            .filter(Boolean)
            .join(' | '),
        });
        const lead = await appendReceptionistLead({
          userId: session.userId,
          callerName: session.collectedName || 'Unknown',
          callerPhone: session.collectedPhone || session.from,
          address: session.collectedAddress || '',
          summary,
          actionItems: done
            ? ['Follow up ASAP — staged script complete (address optional)']
            : ['Follow up — finish staged script fields'],
          transcript: transcriptToText(session.transcript),
          urgent: Boolean(result.lead?.urgent),
          source: 'voice',
        });
        if (lead?.id) session.leadIds = [...(session.leadIds || []), lead.id];
      }
    } catch (e) {
      console.warn('voice think lead:', e);
    }

    try {
      await saveCallSession(session);
    } catch (e) {
      console.warn('voice think save session:', e);
    }

    if (result.action === 'transfer' && transferE164) {
      return twimlXmlResponse(
        transferTwiml({
          say: speak,
          transferTo: transferE164,
          callerId: session.to || undefined,
        })
      );
    }

    if (result.action === 'end' && (scriptComplete(session) || session.callStage === 'thanks')) {
      return twimlXmlResponse(
        sayHangupTwiml(
          speak ||
            `Thanks so much for calling ${session.businessName || 'us'}. We'll be in contact with you as soon as possible. Goodbye!`
        )
      );
    }

    return twimlXmlResponse(
      sayGatherTwiml({
        say: speak,
        gatherActionUrl: VOICE_GATHER_PATH,
      })
    );
  } catch (e: any) {
    console.error('voice think fatal:', e?.message || e);
    return twimlXmlResponse(
      sayGatherTwiml({
        say: 'Sorry about that. What are you calling about today?',
        gatherActionUrl: VOICE_GATHER_PATH,
      })
    );
  }
}
