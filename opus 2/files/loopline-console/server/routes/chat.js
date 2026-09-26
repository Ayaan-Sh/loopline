'use strict';

const express = require('express');
const store = require('../lib/store');
const bot = require('../lib/bot');
const meta = require('../lib/meta');
const config = require('../config');
const { scoreLead } = require('../lib/scoring');
const { buildLadder, cadenceFor } = require('../lib/bot');

const router = express.Router();

/**
 * The core loop: an inbound message comes in, the bot reads it, pulls out
 * fields, replies, and the lead gets re-scored. Used by the webhooks below and
 * by the console's test console. No external chatbot service involved.
 */
async function handleInbound({ lead, text, channel }) {
  const history = await store.listMessages(lead.id);
  await store.addMessage({ lead_id: lead.id, direction: 'inbound', channel, body: text });

  const { reply, intent, slots, stop } = await bot.respond({ text, lead, history });

  const patch = { ...slots, last_contact_at: new Date().toISOString() };
  if (stop) {
    patch.stage = 'DNC';
    patch.consent = false;
    await store.cancelTasksFor(lead.id);
  } else if (['NEW', 'WORKING'].includes(lead.stage)) {
    patch.stage = 'ENGAGED';
  }

  const merged = { ...lead, ...patch };
  const messages = await store.listMessages(lead.id);
  const result = scoreLead(merged, messages);

  if (result.band === 'HOT' && !['SV_BOOKED', 'WON'].includes(merged.stage) && !stop) {
    patch.stage = intent === 'schedule_visit' ? 'SV_BOOKED' : 'QUALIFIED';
  }

  const updated = await store.updateLead(lead.id, { ...patch, score: result.score, band: result.band });

  if (!stop) {
    await store.addMessage({ lead_id: lead.id, direction: 'outbound', channel, body: reply });
  }
  await store.logActivity({
    lead_id: lead.id,
    type: 'bot_reply',
    channel,
    summary: `Intent ${intent} → ${result.band} (${result.score})`,
    actor: 'bot',
  });

  // Re-pace the ladder to match the new temperature.
  if (!stop && Object.keys(slots).length) {
    const { steps, compress } = cadenceFor(result.band);
    await store.cancelTasksFor(lead.id);
    buildLadder(updated).slice(0, steps).forEach((s, i) => {
      store.upsertTask({
        lead_id: lead.id, ...s,
        due_at: new Date(Date.now() + (i + 1) * compress * 86400000).toISOString(),
      });
    });
  }

  return {
    reply: stop ? null : reply,
    intent,
    extracted: slots,
    score: result.score,
    band: result.band,
    reasons: result.reasons,
    next_action: result.next_action,
    lead: { ...updated, ...result },
  };
}

/* Test console / manual bot turn ------------------------------------- */
router.post('/reply', async (req, res, next) => {
  try {
    const { leadId, text, channel = 'whatsapp' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Send the message text to analyse' });

    if (!leadId) {
      // Stateless preview — useful for tuning the bot before wiring a number.
      const { reply, intent, slots } = await bot.respond({ text, lead: {}, history: [] });
      const fake = { source: 'whatsapp', ...slots };
      const result = scoreLead(fake, [{ direction: 'inbound', body: text, created_at: new Date().toISOString() }]);
      return res.json({ reply, intent, extracted: slots, ...result, preview: true });
    }

    const lead = await store.getLead(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(await handleInbound({ lead, text, channel }));
  } catch (e) { next(e); }
});

/** Score a response without touching the pipeline. */
router.post('/analyse', async (req, res, next) => {
  try {
    const { text, lead = {} } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Send the message text to analyse' });
    const intent = bot.detectIntent(text);
    const slots = bot.extractSlots(text, lead);
    const result = scoreLead({ ...lead, ...slots }, [{ direction: 'inbound', body: text, created_at: new Date().toISOString() }]);
    res.json({ intent, extracted: slots, missing: bot.missingSlots({ ...lead, ...slots }), ...result });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------------ */
/* Inbound webhooks                                                    */
/* ------------------------------------------------------------------ */

/**
 * Twilio SMS / WhatsApp. Point the number's messaging webhook at
 * POST /api/chat/webhook/twilio and the bot answers inline via TwiML.
 */
router.post('/webhook/twilio', async (req, res) => {
  try {
    const from = (req.body.From || '').replace('whatsapp:', '');
    const text = req.body.Body || '';
    const channel = (req.body.From || '').startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    if (!from || !text) return res.type('text/xml').send('<Response/>');

    let lead = await store.findLeadByPhone(from);
    if (!lead) {
      const s = scoreLead({ phone: from, source: 'whatsapp' }, []);
      lead = await store.createLead({
        full_name: req.body.ProfileName || 'Unknown',
        phone: from, source: channel === 'whatsapp' ? 'whatsapp' : 'manual',
        consent: true, score: s.score, band: s.band,
      });
    }

    const out = await handleInbound({ lead, text, channel });
    const reply = out.reply
      ? `<Response><Message>${escapeXml(out.reply)}</Message></Response>`
      : '<Response/>';
    res.type('text/xml').send(reply);
  } catch (e) {
    console.error('twilio webhook', e);
    res.type('text/xml').send('<Response/>');
  }
});

/** Meta lead-ads webhook verification handshake. */
router.get('/webhook/meta', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.meta.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

/** Meta lead-ads webhook: a new form submission arrives in real time. */
router.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200); // acknowledge fast, then work
  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const leadgenId = change.value?.leadgen_id;
        if (!leadgenId) continue;
        const l = await meta.fetchLeadById(leadgenId);
        if (l.phone && await store.findLeadByPhone(l.phone)) continue;

        const payload = {
          full_name: l.fullName, phone: l.phone, email: l.email,
          source: 'meta_lead_ad', campaign_id: l.campaignId, campaign_name: l.campaignName,
          locality: l.city, budget: l.budget, property_type: l.propertyType,
          timeline: l.timeline, consent: true, external_id: l.externalId,
        };
        const s = scoreLead(payload, []);
        const lead = await store.createLead({ ...payload, score: s.score, band: s.band });
        buildLadder(lead).forEach((step) => store.upsertTask({ lead_id: lead.id, ...step }));
        await store.logActivity({ lead_id: lead.id, type: 'created', summary: `Meta lead ad — ${l.campaignName || 'unknown campaign'}`, actor: 'meta' });
      }
    }
  } catch (e) {
    console.error('meta webhook', e);
  }
});

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

module.exports = router;
module.exports.handleInbound = handleInbound;
