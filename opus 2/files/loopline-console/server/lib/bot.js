'use strict';

/**
 * Loopline's own qualification bot.
 *
 * This replaces the external chatbot webhook entirely. It runs on rules by
 * default, so it works offline with zero API cost and zero third-party
 * dependency. If LLM_BASE_URL is configured it will phrase the reply with an
 * OpenAI-compatible model (Ollama, vLLM, LM Studio, OpenRouter) and fall back
 * to the rule reply if that call fails — the conversation never breaks because
 * a model is down.
 *
 * Responsibilities:
 *   1. Read an inbound message and work out what the lead means.
 *   2. Pull structured fields out of it (budget, locality, timeline, type, name).
 *   3. Decide the single next question worth asking.
 *   4. Hand the result to the scoring engine for a hot/warm/cold read.
 */

const config = require('../config');
const { parseBudget, normalizeTimeline } = require('./scoring');

const SLOTS = ['full_name', 'budget', 'locality', 'property_type', 'timeline'];

const INTENTS = [
  { name: 'opt_out', re: /\b(stop|unsubscribe|not interested|do ?n'?t (call|contact)|remove me|band karo)\b/i },
  { name: 'wrong_number', re: /\b(wrong number|galat number|who is this|kaun)\b/i },
  { name: 'schedule_visit', re: /\b(site visit|visit|come see|schedule|appointment|saturday|sunday|weekend|kab aa)\b/i },
  { name: 'price_inquiry', re: /\b(price|rate|cost|budget kya|kitna|how much|per sq|carpet area)\b/i },
  { name: 'availability', re: /\b(available|possession|ready to move|inventory|units left|floor)\b/i },
  { name: 'financing', re: /\b(loan|emi|sanction|pre[- ]?approved|down ?payment|bank)\b/i },
  { name: 'location_question', re: /\b(where|location|address|near|metro|distance|kahan)\b/i },
  { name: 'callback', re: /\b(call me|phone karo|ring me|call back)\b/i },
  { name: 'objection', re: /\b(too expensive|costly|mehenga|far|small|thinking|later|busy)\b/i },
  { name: 'greeting', re: /^\s*(hi|hello|hey|namaste|hii+|good (morning|evening|afternoon))\b/i },
  { name: 'affirmative', re: /^\s*(yes|yeah|yup|haan|ok|okay|sure|interested)\b/i },
];

const PROPERTY_TYPES = /\b(\d)\s*bhk\b|\b(studio|villa|penthouse|plot|shop|office)\b/i;

const CITY_HINTS = [
  'kharadi', 'wakad', 'hinjawadi', 'baner', 'balewadi', 'aundh', 'kothrud',
  'viman nagar', 'koregaon park', 'hadapsar', 'magarpatta', 'ravet', 'pimpri',
  'chinchwad', 'undri', 'wagholi', 'nibm', 'bavdhan', 'pashan', 'kalyani nagar',
];

/* ------------------------------------------------------------------ */
/* Understanding                                                       */
/* ------------------------------------------------------------------ */

function detectIntent(text) {
  const t = String(text || '');
  for (const i of INTENTS) if (i.re.test(t)) return i.name;
  return 'other';
}

function extractSlots(text, existing = {}) {
  const t = String(text || '');
  const found = {};

  const budgetMatch = t.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(cr|crore|l\b|lakh|lac|k\b)?/i);
  if (/\b(budget|price|afford|range|upto|up to|around|under|within)\b/i.test(t) || /\b(cr|crore|lakh|lac|l)\b/i.test(t)) {
    if (budgetMatch) {
      const b = parseBudget(budgetMatch[0]);
      if (b && b > 100000) found.budget = b;
    }
  }

  const pt = t.match(PROPERTY_TYPES);
  if (pt) found.property_type = pt[1] ? `${pt[1]}BHK` : pt[2].toLowerCase();

  const loc = CITY_HINTS.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(t));
  if (loc) found.locality = loc.replace(/\b\w/g, (m) => m.toUpperCase());

  if (/\b(\d+\s*(day|week|month|year)s?|immediate|urgent|asap|this month|next month)\b/i.test(t)) {
    const tl = normalizeTimeline(t.match(/\b(\d+\s*(?:day|week|month|year)s?|immediate|urgent|asap|this month|next month)\b/i)[0]);
    if (tl !== 'unknown') found.timeline = tl;
  }

  const nameMatch = t.match(/\b(?:my name is|this is|i am|i'm|naam)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch && !existing.full_name) found.full_name = nameMatch[1];

  return found;
}

function missingSlots(lead) {
  return SLOTS.filter((s) => {
    const v = lead[s];
    return v === null || v === undefined || v === '' || v === 'Unknown';
  });
}

/* ------------------------------------------------------------------ */
/* Replying                                                            */
/* ------------------------------------------------------------------ */

const SLOT_QUESTIONS = {
  full_name: 'Before I pull options — what name should I save this under?',
  budget: 'What budget range are you working with? That decides which projects I send.',
  locality: 'Which area are you focused on?',
  property_type: 'Are you looking at a 2BHK, 3BHK, or something larger?',
  timeline: 'How soon are you planning to buy — this month, or a few months out?',
};

const ANSWERS = {
  price_inquiry: (c) => `Pricing depends on the tower and floor, so I do not want to quote you a wrong number. Current inventory in ${c.city} starts around ₹${(c.minBudget / 100000).toFixed(0)}L.`,
  availability: () => 'We have ready-possession and under-construction units in the same project.',
  financing: () => 'We work with four banks and can get an in-principle sanction in about 48 hours.',
  location_question: (c) => `The project is in ${c.city}, and I can send the exact pin along with the brochure.`,
  schedule_visit: () => 'I can hold a slot this weekend — Saturday morning or Sunday evening works better?',
  callback: () => 'I can have a sales manager call you. What time suits you today?',
  objection: () => 'Fair. Tell me what feels off — price, location, or size — and I will send something that fits better.',
  greeting: (c) => `Hi, ${c.agentName} here from ${c.name}.`,
  affirmative: () => 'Good.',
  wrong_number: () => 'Apologies for the disturbance — removing this number now.',
  opt_out: () => 'Understood, I will not message again. Thanks for your time.',
  other: () => 'Got it.',
};

/**
 * Build the reply the bot should send next.
 * Returns { reply, intent, slots, stop }.
 */
async function respond({ text, lead = {}, history = [] }) {
  const intent = detectIntent(text);
  const slots = extractSlots(text, lead);
  const merged = { ...lead, ...slots };

  if (intent === 'opt_out' || intent === 'wrong_number') {
    return { reply: ANSWERS[intent](config.business), intent, slots, stop: true };
  }

  const answer = (ANSWERS[intent] || ANSWERS.other)(config.business);
  const gaps = missingSlots(merged);
  const question = gaps.length ? SLOT_QUESTIONS[gaps[0]] : null;

  let reply;
  if (intent === 'schedule_visit' && gaps.length <= 1) {
    reply = answer; // stop qualifying, they are ready
  } else if (question) {
    reply = `${answer} ${question}`.trim();
  } else {
    reply = `${answer} I have everything I need — want me to block a site visit this weekend?`;
  }

  const phrased = await phraseWithLLM({ reply, text, intent, lead: merged, history });
  return { reply: phrased || reply, intent, slots, stop: false };
}

/**
 * Optional: rewrite the rule-built reply so it reads human. Falls back
 * silently. The rules still decide *what* is said; the model only decides how.
 */
async function phraseWithLLM({ reply, text, intent, lead, history }) {
  if (!config.llm.baseUrl) return null;
  const sys = [
    `You are ${config.business.agentName}, a real estate sales assistant for ${config.business.name} in ${config.business.city}.`,
    'Rewrite the draft reply so it sounds like a real person over WhatsApp.',
    'Rules: under 35 words, no emojis, no greetings if the conversation already started,',
    'keep every fact and every question from the draft, ask at most one question.',
    'Reply with the message text only.',
  ].join(' ');

  const convo = history.slice(-6).map((m) => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body || '',
  }));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${config.llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.llm.apiKey ? { Authorization: `Bearer ${config.llm.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.4,
        max_tokens: 120,
        messages: [
          { role: 'system', content: sys },
          ...convo,
          { role: 'user', content: `Lead just said: "${text}"\nDetected intent: ${intent}\nKnown: ${JSON.stringify(lead.budget ? { budget: lead.budget, locality: lead.locality } : {})}\nDraft reply: "${reply}"` },
        ],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    const out = data?.choices?.[0]?.message?.content;
    return out ? String(out).trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Follow-up ladder                                                    */
/* ------------------------------------------------------------------ */

/**
 * 15-day persistence cadence. Day offsets are deliberate: quick twice, then
 * spaced out so it never reads as spam.
 */
const LADDER = [
  { day: 0, channel: 'whatsapp', body: (l) => `Hi${l.full_name ? ' ' + firstName(l.full_name) : ''}, ${config.business.agentName} from ${config.business.name}. You asked about ${l.property_type || 'a home'}${l.locality ? ' in ' + l.locality : ''} — still looking?` },
  { day: 1, channel: 'whatsapp', body: (l) => `Sending you two options that match your budget${l.locality ? ' in ' + l.locality : ''}. Want the floor plans?` },
  { day: 3, channel: 'sms', body: () => 'Quick one — do you want a weekend site visit, or should I send details on WhatsApp instead?' },
  { day: 5, channel: 'email', body: (l) => `Sharing the full price sheet and floor plans for ${l.locality || config.business.city}.` },
  { day: 8, channel: 'call', body: () => 'Call attempt — check interest and possession preference.' },
  { day: 12, channel: 'whatsapp', body: () => 'Two units in your range got booked this week. Want me to hold one before the next price revision?' },
  { day: 15, channel: 'whatsapp', body: () => 'Last message from me on this — reply anytime and I will pick it back up.' },
];

function firstName(n) { return String(n).trim().split(/\s+/)[0]; }

/** Build the schedule of follow-ups for a lead, starting now. */
function buildLadder(lead, startAt = new Date()) {
  return LADDER.map((step, i) => ({
    step: i + 1,
    channel: step.channel,
    body: step.body(lead),
    due_at: new Date(startAt.getTime() + step.day * 86400000).toISOString(),
  }));
}

/** HOT leads get a compressed ladder — waiting three days loses the deal. */
function cadenceFor(band) {
  if (band === 'HOT') return { steps: 4, compress: 0.5 };
  if (band === 'WARM') return { steps: 7, compress: 1 };
  return { steps: 3, compress: 2 };
}

module.exports = {
  respond, detectIntent, extractSlots, missingSlots,
  buildLadder, cadenceFor, LADDER, SLOTS,
};
