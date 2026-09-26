'use strict';

/**
 * Lead temperature engine.
 *
 * Deterministic, auditable, and tunable from one place. Every point it awards
 * comes back with a reason, so a sales manager can see why a lead is hot
 * instead of trusting a black box. No model call is required — an LLM can
 * enrich the read (see lib/bot.js) but never replaces this.
 *
 * Total is clamped to 0-100.
 *   HOT   >= 70   act today
 *   WARM  45-69   nurture on the ladder
 *   COLD  < 45    low-cost drip or park
 */

const config = require('../config');

const WEIGHTS = {
  budget: 25,
  timeline: 20,
  intent: 20,
  engagement: 15,
  completeness: 10,
  source: 10,
};

const SOURCE_QUALITY = {
  referral: 1.0,
  website: 0.85,
  meta_lead_ad: 0.75,
  whatsapp: 0.7,
  walk_in: 0.9,
  manual: 0.5,
  outbound_list: 0.3,
  import: 0.4,
};

const BUYING_SIGNALS = [
  { re: /\b(site\s*visit|visit|come see|show me the flat|dekhna)\b/i, w: 6, label: 'asked about a site visit' },
  { re: /\b(book|booking|token|advance|blocking)\b/i, w: 6, label: 'used booking language' },
  { re: /\b(loan|pre[- ]?approved|sanction|home loan|emi)\b/i, w: 5, label: 'finance already in motion' },
  { re: /\b(price|rate|cost|per sq|carpet|final price|kitna)\b/i, w: 4, label: 'asked for pricing' },
  { re: /\b(possession|ready to move|rtmi|occupancy)\b/i, w: 4, label: 'asked about possession' },
  { re: /\b(call me|phone karo|available now|urgent|asap|today|tomorrow)\b/i, w: 5, label: 'wants contact now' },
  { re: /\b(floor plan|brochure|layout|3d|photos)\b/i, w: 3, label: 'requested collateral' },
  { re: /\b(negotiab|discount|offer|best price)\b/i, w: 4, label: 'negotiating' },
];

const KILL_SIGNALS = [
  { re: /\b(not interested|no thanks|don'?t call|stop|unsubscribe|remove me|galat number|wrong number)\b/i, w: 45, label: 'explicit opt-out' },
  { re: /\b(already bought|already booked|purchased elsewhere)\b/i, w: 35, label: 'bought elsewhere' },
  { re: /\b(just looking|timepass|curious only|survey)\b/i, w: 12, label: 'browsing only' },
  { re: /\b(rent|rental|tenant|lease)\b/i, w: 10, label: 'wants rental, not purchase' },
];

const TIMELINE_POINTS = {
  '7d': 1.0, '15d': 1.0, '30d': 0.95, '60d': 0.75,
  '90d': 0.6, '180d': 0.35, '365d': 0.15, 'unknown': 0.2,
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.floor((new Date(b) - new Date(a)) / 86400000);
}

function normalizeTimeline(raw) {
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase();
  if (/immediate|urgent|this (week|month)|asap|7|1 ?month/.test(s)) return '30d';
  const m = s.match(/(\d+)\s*(d|day|w|week|m|month|y|year)/);
  if (!m) return TIMELINE_POINTS[s] ? s : 'unknown';
  const n = Number(m[1]);
  const unit = m[2][0];
  const days = unit === 'd' ? n : unit === 'w' ? n * 7 : unit === 'm' ? n * 30 : n * 365;
  if (days <= 30) return '30d';
  if (days <= 60) return '60d';
  if (days <= 90) return '90d';
  if (days <= 180) return '180d';
  return '365d';
}

/** Parse Indian-style budget text: "95 lakh", "1.2 cr", "9500000", "95L". */
function parseBudget(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  const s = String(raw).toLowerCase().replace(/,/g, '').trim();
  const num = parseFloat(s.replace(/[^0-9.]/g, ''));
  if (!isFinite(num)) return null;
  if (/cr|crore/.test(s)) return Math.round(num * 10000000);
  if (/l\b|lakh|lac/.test(s)) return Math.round(num * 100000);
  if (/k\b/.test(s)) return Math.round(num * 1000);
  if (num < 1000) return Math.round(num * 100000); // bare "95" means 95 lakh
  return Math.round(num);
}

/**
 * @param {object} lead     lead row
 * @param {array}  messages message rows, oldest first
 * @returns {{score:number, band:string, reasons:string[], next_action:string, breakdown:object}}
 */
function scoreLead(lead = {}, messages = []) {
  const reasons = [];
  const breakdown = {};
  const minBudget = config.business.minBudget;

  /* --- budget fit ------------------------------------------------- */
  const budget = parseBudget(lead.budget);
  let budgetPts;
  if (budget == null) {
    budgetPts = WEIGHTS.budget * 0.2;
    reasons.push('Budget not captured yet');
  } else if (budget >= minBudget * 1.25) {
    budgetPts = WEIGHTS.budget;
    reasons.push('Budget comfortably above inventory floor');
  } else if (budget >= minBudget) {
    budgetPts = WEIGHTS.budget * 0.85;
    reasons.push('Budget matches available inventory');
  } else if (budget >= minBudget * 0.8) {
    budgetPts = WEIGHTS.budget * 0.5;
    reasons.push('Budget is stretchable with a discount');
  } else {
    budgetPts = WEIGHTS.budget * 0.1;
    reasons.push('Budget is below what we can sell');
  }
  breakdown.budget = Math.round(budgetPts);

  /* --- timeline ---------------------------------------------------- */
  const tl = normalizeTimeline(lead.timeline);
  const timelinePts = WEIGHTS.timeline * (TIMELINE_POINTS[tl] ?? 0.2);
  if (tl === 'unknown') reasons.push('Timeline unknown');
  else if (TIMELINE_POINTS[tl] >= 0.9) reasons.push(`Buying within ${tl.replace('d', ' days')}`);
  else if (TIMELINE_POINTS[tl] <= 0.35) reasons.push('Long horizon — not a near-term close');
  breakdown.timeline = Math.round(timelinePts);

  /* --- intent from what they actually said -------------------------- */
  const inbound = messages.filter((m) => m.direction === 'inbound');
  const text = inbound.map((m) => m.body || '').join(' \n ') + ' ' + (lead.notes || '');
  let intentRaw = 0;
  BUYING_SIGNALS.forEach((sig) => {
    if (sig.re.test(text)) { intentRaw += sig.w; reasons.push(`Signal: ${sig.label}`); }
  });
  const intentPts = Math.min(WEIGHTS.intent, intentRaw);
  breakdown.intent = Math.round(intentPts);

  /* --- engagement --------------------------------------------------- */
  let engagementPts = 0;
  if (inbound.length >= 1) engagementPts += 5;
  if (inbound.length >= 3) engagementPts += 4;
  const avgLen = inbound.length
    ? inbound.reduce((a, m) => a + (m.body || '').length, 0) / inbound.length : 0;
  if (avgLen > 40) engagementPts += 3;
  if (inbound.length) {
    const last = inbound[inbound.length - 1];
    const since = daysBetween(last.created_at, new Date());
    if (since !== null && since <= 1) engagementPts += 3;
  }
  engagementPts = Math.min(WEIGHTS.engagement, engagementPts);
  if (inbound.length === 0) reasons.push('No reply from the lead yet');
  else if (engagementPts >= 10) reasons.push(`Replying actively (${inbound.length} inbound messages)`);
  breakdown.engagement = Math.round(engagementPts);

  /* --- profile completeness ----------------------------------------- */
  const slots = ['full_name', 'phone', 'budget', 'locality', 'property_type'];
  const filled = slots.filter((s) => lead[s] !== null && lead[s] !== undefined && lead[s] !== '').length;
  const completenessPts = WEIGHTS.completeness * (filled / slots.length);
  breakdown.completeness = Math.round(completenessPts);
  if (filled <= 2) reasons.push('Profile is mostly empty — qualify before calling');

  /* --- source quality ------------------------------------------------ */
  const sq = SOURCE_QUALITY[lead.source] ?? 0.5;
  const sourcePts = WEIGHTS.source * sq;
  breakdown.source = Math.round(sourcePts);
  if (sq >= 0.85) reasons.push(`High-quality source: ${lead.source}`);
  if (sq <= 0.35) reasons.push(`Cold source: ${lead.source}`);

  /* --- penalties ------------------------------------------------------ */
  let penalty = 0;
  KILL_SIGNALS.forEach((sig) => {
    if (sig.re.test(text)) { penalty += sig.w; reasons.push(`Negative: ${sig.label}`); }
  });
  if (lead.consent === false && lead.source === 'outbound_list') {
    penalty += 8;
    reasons.push('No consent on record — outbound is restricted');
  }
  const staleness = lead.last_contact_at ? daysBetween(lead.last_contact_at, new Date()) : null;
  if (staleness !== null && staleness > 3) {
    const decay = Math.min(15, staleness - 3);
    penalty += decay;
    reasons.push(`Gone quiet for ${staleness} days`);
  }
  if ((lead.attempts || 0) >= 4 && inbound.length === 0) {
    penalty += 10;
    reasons.push('Four contact attempts, zero response');
  }
  breakdown.penalty = -Math.round(penalty);

  const raw = budgetPts + timelinePts + intentPts + engagementPts + completenessPts + sourcePts - penalty;
  const score = Math.round(clamp(raw, 0, 100));

  const optedOut = /\b(not interested|stop|unsubscribe|don'?t call|remove me)\b/i.test(text);
  let band;
  if (optedOut) band = 'COLD';
  else if (score >= 70) band = 'HOT';
  else if (score >= 45) band = 'WARM';
  else band = 'COLD';

  return {
    score,
    band,
    reasons: reasons.slice(0, 8),
    next_action: nextAction(band, lead, optedOut),
    breakdown,
    parsed: { budget, timeline: tl },
  };
}

function nextAction(band, lead, optedOut) {
  if (optedOut) return 'Mark do-not-contact and stop all follow-ups';
  if (band === 'HOT') {
    return lead.stage === 'SV_BOOKED'
      ? 'Confirm the site visit and send directions'
      : 'Call within the hour and lock a site visit';
  }
  if (band === 'WARM') return 'Send the next ladder message and ask one qualifying question';
  return 'Low-cost drip only — revisit in 15 days';
}

module.exports = { scoreLead, parseBudget, normalizeTimeline, WEIGHTS };
