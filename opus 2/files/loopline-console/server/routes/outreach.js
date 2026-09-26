'use strict';

const express = require('express');
const store = require('../lib/store');
const channels = require('../lib/channels');
const config = require('../config');
const { scoreLead } = require('../lib/scoring');
const { buildLadder, cadenceFor } = require('../lib/bot');

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Draft generation                                                    */
/* ------------------------------------------------------------------ */

function firstName(n) { return String(n || 'there').trim().split(/\s+/)[0]; }
function money(n) { return n ? '₹' + Number(n).toLocaleString('en-IN') : 'your budget'; }

function draft(lead, band, channel) {
  const name = firstName(lead.full_name);
  const area = lead.locality || config.business.city;
  const type = lead.property_type || 'a home';
  const agent = config.business.agentName;
  const biz = config.business.name;

  if (channel === 'email') {
    if (band === 'HOT') {
      return {
        subject: `${type} in ${area} — holding a slot for you`,
        body: `Hi ${name},\n\nYou asked about ${type} in ${area} within ${money(lead.budget)}. I have two units that fit and can hold one for a viewing this weekend.\n\nSaturday 11am or Sunday 5pm — which works?\n\n${agent}\n${biz}`,
      };
    }
    if (band === 'WARM') {
      return {
        subject: `Floor plans and pricing for ${area}`,
        body: `Hi ${name},\n\nAttaching the current price sheet and floor plans for ${area}. Two things worth knowing: possession is immediate on the B tower, and the current pricing holds till month end.\n\nIf you tell me your target budget I will shortlist three options instead of sending everything.\n\n${agent}\n${biz}`,
      };
    }
    return {
      subject: `Still looking in ${area}?`,
      body: `Hi ${name},\n\nChecking in once. If ${area} is still on your list I can send what is available in ${money(lead.budget)} this month.\n\nIf the plan has changed, reply "stop" and I will close this out.\n\n${agent}\n${biz}`,
    };
  }

  if (channel === 'call') {
    return {
      subject: 'Call script',
      body: band === 'HOT'
        ? `Open: "Hi ${name}, ${agent} from ${biz} — you enquired about ${type} in ${area}."\nConfirm: budget ${money(lead.budget)}, timeline ${lead.timeline || 'unknown'}.\nAsk for: a site visit slot this weekend.\nIf busy: offer to send the floor plan on WhatsApp and call back at a fixed time.`
        : `Open: "Hi ${name}, ${agent} from ${biz}, quick 30 seconds."\nQualify: budget, area, when they plan to buy.\nGoal: get one missing field, then book a callback. Do not pitch.`,
    };
  }

  // whatsapp / sms
  if (band === 'HOT') {
    return { subject: null, body: `Hi ${name}, ${agent} from ${biz}. Two ${type} units in ${area} match what you described. Can I block a site visit Saturday 11am?` };
  }
  if (band === 'WARM') {
    return { subject: null, body: `Hi ${name}, ${agent} here. Sending floor plans for ${area} — want the price sheet too, or should I shortlist three options in ${money(lead.budget)}?` };
  }
  return { subject: null, body: `Hi ${name}, ${agent} from ${biz}. Still looking in ${area}? Reply with your budget and I will send only what fits. Reply STOP to opt out.` };
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/** Preview what would be sent, without sending it. */
router.get('/draft/:leadId', async (req, res, next) => {
  try {
    const lead = await store.getLead(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const messages = await store.listMessages(lead.id);
    const result = scoreLead(lead, messages);
    const channel = req.query.channel || 'whatsapp';
    res.json({
      channel,
      band: result.band,
      score: result.score,
      next_action: result.next_action,
      ...draft(lead, result.band, channel),
    });
  } catch (e) { next(e); }
});

/** Send on any channel. Body may override subject/body from the draft. */
router.post('/send', async (req, res, next) => {
  try {
    const { leadId, channel = 'whatsapp', subject, body, agentNumber, mode } = req.body || {};
    const lead = await store.getLead(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.stage === 'DNC') return res.status(409).json({ error: 'This lead is marked do-not-contact' });

    const messages = await store.listMessages(lead.id);
    const result = scoreLead(lead, messages);
    const d = draft(lead, result.band, channel);
    const text = body || d.body;

    if (channel !== 'call' && channels.withinQuietHours()) {
      return res.status(409).json({
        error: `It is quiet hours (${config.business.quietHours}). Queue this for the morning instead of sending now.`,
        code: 'QUIET_HOURS',
      });
    }

    const out = await channels.send(channel, {
      to: channel === 'email' ? lead.email : lead.phone,
      subject: subject || d.subject,
      body: text,
      agentNumber,
      mode,
      say: text,
    });

    if (!out.ok) return res.status(400).json(out);

    if (channel !== 'call') {
      await store.addMessage({ lead_id: lead.id, direction: 'outbound', channel, body: text });
    }
    await store.logActivity({
      lead_id: lead.id,
      type: channel === 'call' ? 'call' : 'message',
      channel,
      summary: out.simulated ? `${channel} (simulated): ${text.slice(0, 80)}` : `${channel}: ${text.slice(0, 80)}`,
      actor: 'agent',
    });

    const nextStage = lead.stage === 'NEW' ? 'WORKING' : lead.stage;
    const updated = await store.updateLead(lead.id, {
      last_contact_at: new Date().toISOString(),
      attempts: (lead.attempts || 0) + 1,
      stage: nextStage,
    });

    res.json({ ...out, lead: { ...updated, ...scoreLead(updated, await store.listMessages(lead.id)) } });
  } catch (e) { next(e); }
});

/** Queue the follow-up ladder for a lead, paced by temperature. */
router.post('/ladder/:leadId', async (req, res, next) => {
  try {
    const lead = await store.getLead(req.params.leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const messages = await store.listMessages(lead.id);
    const { band } = scoreLead(lead, messages);
    const { steps, compress } = cadenceFor(band);

    await store.cancelTasksFor(lead.id);
    const plan = buildLadder(lead).slice(0, steps).map((s, i) => ({
      ...s,
      due_at: new Date(Date.now() + i * compress * 86400000).toISOString(),
    }));
    for (const step of plan) await store.upsertTask({ lead_id: lead.id, ...step });

    await store.logActivity({ lead_id: lead.id, type: 'ladder', summary: `${band} cadence queued — ${plan.length} steps` });
    res.json({ ok: true, band, queued: plan.length, plan });
  } catch (e) { next(e); }
});

/** Anything queued and due. Call this from cron, or hit "Run follow-ups". */
router.post('/run', async (req, res, next) => {
  try {
    const tasks = await store.dueTasks();
    const sent = [];
    for (const task of tasks) {
      const lead = await store.getLead(task.lead_id);
      if (!lead || ['WON', 'LOST', 'DNC'].includes(lead.stage)) {
        await store.closeTask(task.id, 'cancelled');
        continue;
      }
      if (task.channel !== 'call' && channels.withinQuietHours()) continue;

      const out = await channels.send(task.channel, {
        to: task.channel === 'email' ? lead.email : lead.phone,
        subject: `Following up — ${lead.locality || config.business.city}`,
        body: task.body,
        say: task.body,
      });
      if (out.ok) {
        if (task.channel !== 'call') {
          await store.addMessage({ lead_id: lead.id, direction: 'outbound', channel: task.channel, body: task.body });
        }
        await store.logActivity({ lead_id: lead.id, type: 'followup', channel: task.channel, summary: `Ladder step ${task.step}`, actor: 'bot' });
        await store.updateLead(lead.id, { last_contact_at: new Date().toISOString(), attempts: (lead.attempts || 0) + 1 });
        await store.closeTask(task.id, 'sent');
        sent.push({ lead: lead.full_name, channel: task.channel, step: task.step, simulated: !!out.simulated });
      } else {
        await store.closeTask(task.id, 'failed');
      }
    }
    res.json({ ok: true, due: tasks.length, sent: sent.length, details: sent });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.draft = draft;
