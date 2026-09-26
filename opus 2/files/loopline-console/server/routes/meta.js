'use strict';

const express = require('express');
const meta = require('../lib/meta');
const config = require('../config');
const store = require('../lib/store');

const router = express.Router();

/** Everything the overview tab needs, in one request. */
router.get('/overview', async (req, res, next) => {
  try {
    const preset = req.query.range || 'last_30d';
    const [summary, campaigns] = await Promise.all([
      meta.accountSummary({ datePreset: preset }),
      meta.listCampaigns(),
    ]);

    // Blend ad spend with pipeline reality: what did those leads turn into?
    const leads = await store.listLeads({ limit: 1000 });
    const attributed = leads.filter((l) => l.source === 'meta_lead_ad');
    const qualified = attributed.filter((l) => ['QUALIFIED', 'SV_BOOKED', 'NEGOTIATION', 'WON'].includes(l.stage));

    res.json({
      range: preset,
      sampleData: config.demo.meta,
      totals: summary.totals,
      daily: summary.daily,
      campaigns: summary.campaigns.map((c) => {
        const live = campaigns.find((x) => x.id === c.campaignId);
        return { ...c, status: live?.status || 'UNKNOWN', dailyBudget: live?.dailyBudget ?? null, objective: live?.objective };
      }),
      allCampaigns: campaigns,
      pipeline: {
        leadsFromAds: attributed.length,
        qualified: qualified.length,
        costPerQualified: qualified.length ? summary.totals.spend / qualified.length : 0,
        qualificationRate: attributed.length ? (qualified.length / attributed.length) * 100 : 0,
      },
    });
  } catch (e) { next(e); }
});

router.get('/campaigns', async (req, res, next) => {
  try { res.json({ campaigns: await meta.listCampaigns(), sampleData: config.demo.meta }); }
  catch (e) { next(e); }
});

router.get('/insights', async (req, res, next) => {
  try {
    const rows = await meta.campaignInsights({ datePreset: req.query.range || 'last_30d' });
    res.json({ rows, sampleData: config.demo.meta });
  } catch (e) { next(e); }
});

router.get('/forms', async (req, res, next) => {
  try { res.json({ forms: await meta.listLeadForms(), sampleData: config.demo.meta }); }
  catch (e) { next(e); }
});

/** Create campaign + ad set + creative + ad. Always created paused. */
router.post('/campaigns', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Give the campaign a name' });
    if (!b.dailyBudget || Number(b.dailyBudget) < 100) {
      return res.status(400).json({ error: 'Daily budget must be at least ₹100' });
    }
    const result = await meta.createCampaign({
      name: b.name,
      objective: b.objective || 'OUTCOME_LEADS',
      dailyBudget: Math.round(Number(b.dailyBudget) * 100), // Meta expects minor units
      leadFormId: b.leadFormId,
      pageId: b.pageId,
      startTime: b.startTime,
      endTime: b.endTime,
      targeting: {
        cities: b.cities,
        radiusKm: b.radiusKm,
        ageMin: b.ageMin,
        ageMax: b.ageMax,
        platforms: b.platforms,
        interests: b.interests,
      },
      adCopy: {
        primaryText: b.primaryText,
        headline: b.headline,
        description: b.description,
        link: b.link,
        cta: b.cta,
        imageHash: b.imageHash,
      },
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.post('/campaigns/:id/status', async (req, res, next) => {
  try {
    const status = String(req.body?.status || '').toUpperCase();
    if (!['ACTIVE', 'PAUSED', 'ARCHIVED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE, PAUSED or ARCHIVED' });
    }
    res.json(await meta.setCampaignStatus(req.params.id, status));
  } catch (e) { next(e); }
});

router.post('/campaigns/:id/budget', async (req, res, next) => {
  try {
    const rupees = Number(req.body?.dailyBudget);
    if (!rupees || rupees < 100) return res.status(400).json({ error: 'Daily budget must be at least ₹100' });
    res.json(await meta.updateBudget(req.params.id, Math.round(rupees * 100)));
  } catch (e) { next(e); }
});

/** Connection check for the settings screen. */
router.get('/health', async (req, res) => {
  if (config.demo.meta) {
    return res.json({ connected: false, sampleData: true, detail: 'Running on sample data. Add META_ACCESS_TOKEN and META_AD_ACCOUNT_ID to go live.' });
  }
  try {
    const data = await meta.graph(config.meta.adAccountId, {
      params: { fields: 'name,account_status,currency,amount_spent,balance' },
    });
    res.json({
      connected: true,
      account: data.name,
      currency: data.currency,
      accountStatus: data.account_status === 1 ? 'Active' : `Status code ${data.account_status}`,
    });
  } catch (e) {
    res.status(200).json({ connected: false, error: e.message, hint: e.hint });
  }
});

module.exports = router;
