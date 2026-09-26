'use strict';

const express = require('express');
const store = require('../lib/store');
const meta = require('../lib/meta');
const { scoreLead } = require('../lib/scoring');
const { buildLadder } = require('../lib/bot');

const router = express.Router();

const STAGES = ['NEW', 'WORKING', 'ENGAGED', 'QUALIFIED', 'SV_BOOKED', 'NEGOTIATION', 'WON', 'LOST', 'DNC'];

/** Attach a freshly computed score to a lead row. */
async function withScore(lead) {
  const messages = await store.listMessages(lead.id);
  const result = scoreLead(lead, messages);
  return { ...lead, ...result, messageCount: messages.length };
}

/* List ------------------------------------------------------------- */
router.get('/', async (req, res, next) => {
  try {
    const { stage, band, search, limit } = req.query;
    const rows = await store.listLeads({ stage, search, limit: Number(limit) || 200 });
    let scored = await Promise.all(rows.map(withScore));
    if (band) scored = scored.filter((l) => l.band === String(band).toUpperCase());

    const counts = scored.reduce((a, l) => { a[l.band] = (a[l.band] || 0) + 1; return a; }, {});
    const stageCounts = scored.reduce((a, l) => { a[l.stage] = (a[l.stage] || 0) + 1; return a; }, {});

    res.json({
      leads: scored.sort((a, b) => b.score - a.score),
      summary: {
        total: scored.length,
        hot: counts.HOT || 0,
        warm: counts.WARM || 0,
        cold: counts.COLD || 0,
        byStage: stageCounts,
        pipelineValue: scored.filter((l) => l.band !== 'COLD')
          .reduce((a, l) => a + (Number(l.budget) || 0), 0),
      },
      storage: store.mode,
    });
  } catch (e) { next(e); }
});

/* Detail ------------------------------------------------------------ */
router.get('/:id', async (req, res, next) => {
  try {
    const lead = await store.getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    const messages = await store.listMessages(lead.id);
    const activity = await store.listActivity(lead.id);
    res.json({ lead: { ...lead, ...scoreLead(lead, messages) }, messages, activity });
  } catch (e) { next(e); }
});

/* Create ------------------------------------------------------------ */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.phone && !body.email) {
      return res.status(400).json({ error: 'A lead needs at least a phone number or an email address' });
    }
    if (body.phone) {
      const existing = await store.findLeadByPhone(body.phone);
      if (existing) return res.status(409).json({ error: 'That phone number is already in the pipeline', lead: existing });
    }
    const first = scoreLead(body, []);
    const lead = await store.createLead({ ...body, score: first.score, band: first.band });
    await store.logActivity({ lead_id: lead.id, type: 'created', summary: `Lead added from ${lead.source}` });

    // Queue the follow-up ladder straight away.
    buildLadder(lead).forEach((step) => store.upsertTask({ lead_id: lead.id, ...step }));

    res.status(201).json({ lead: await withScore(lead) });
  } catch (e) { next(e); }
});

/* Update ------------------------------------------------------------ */
router.patch('/:id', async (req, res, next) => {
  try {
    const lead = await store.getLead(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const patch = { ...req.body };
    if (patch.stage && !STAGES.includes(patch.stage)) {
      return res.status(400).json({ error: `Stage must be one of: ${STAGES.join(', ')}` });
    }
    const merged = { ...lead, ...patch };
    const messages = await store.listMessages(lead.id);
    const result = scoreLead(merged, messages);
    const updated = await store.updateLead(lead.id, { ...patch, score: result.score, band: result.band });

    if (patch.stage && patch.stage !== lead.stage) {
      await store.logActivity({ lead_id: lead.id, type: 'stage_change', summary: `${lead.stage} → ${patch.stage}` });
      if (['WON', 'LOST', 'DNC'].includes(patch.stage)) await store.cancelTasksFor(lead.id);
    }
    res.json({ lead: { ...updated, ...result } });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await store.deleteLead(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Bulk import (outbound lists) --------------------------------------- */
router.post('/import', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'Send an array of rows to import' });

    const created = [];
    const skipped = [];
    for (const r of rows) {
      if (!r.phone && !r.email) { skipped.push({ row: r, why: 'no phone or email' }); continue; }
      if (r.phone && await store.findLeadByPhone(r.phone)) { skipped.push({ row: r, why: 'duplicate phone' }); continue; }
      const payload = { ...r, source: r.source || 'outbound_list' };
      const s = scoreLead(payload, []);
      created.push(await store.createLead({ ...payload, score: s.score, band: s.band }));
    }
    res.json({ imported: created.length, skipped: skipped.length, details: skipped.slice(0, 20) });
  } catch (e) { next(e); }
});

/* Pull new leads from Meta lead ad forms ------------------------------ */
router.post('/sync/meta', async (req, res, next) => {
  try {
    const forms = await meta.listLeadForms();
    let imported = 0, duplicates = 0;
    const since = req.body?.since || new Date(Date.now() - 7 * 86400000).toISOString();

    for (const form of forms) {
      const leads = await meta.fetchFormLeads(form.id, since);
      for (const l of leads) {
        if (l.phone && await store.findLeadByPhone(l.phone)) { duplicates++; continue; }
        const payload = {
          full_name: l.fullName,
          phone: l.phone,
          email: l.email,
          source: 'meta_lead_ad',
          campaign_id: l.campaignId,
          campaign_name: l.campaignName,
          locality: l.city,
          budget: l.budget,
          property_type: l.propertyType,
          timeline: l.timeline,
          consent: true,
          external_id: l.externalId,
          created_at: l.createdAt,
        };
        const s = scoreLead(payload, []);
        const lead = await store.createLead({ ...payload, score: s.score, band: s.band });
        buildLadder(lead).forEach((step) => store.upsertTask({ lead_id: lead.id, ...step }));
        imported++;
      }
    }
    res.json({ ok: true, forms: forms.length, imported, duplicates });
  } catch (e) { next(e); }
});

/* Rescore everything (after changing the formula weights) -------------- */
router.post('/rescore', async (req, res, next) => {
  try {
    const rows = await store.listLeads({ limit: 1000 });
    let changed = 0;
    for (const lead of rows) {
      const messages = await store.listMessages(lead.id);
      const r = scoreLead(lead, messages);
      if (r.score !== lead.score || r.band !== lead.band) {
        await store.updateLead(lead.id, { score: r.score, band: r.band });
        changed++;
      }
    }
    res.json({ ok: true, rescored: rows.length, changed });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.withScore = withScore;
module.exports.STAGES = STAGES;
