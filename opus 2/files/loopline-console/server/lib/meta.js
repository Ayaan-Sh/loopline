'use strict';

/**
 * Meta Marketing API client.
 *
 * Every call goes through `graph()` so auth, versioning, and error shape are
 * handled once. When no token is configured the module serves realistic sample
 * data instead of failing, which is what makes the console demo-able before a
 * client hands over their ad account.
 *
 * Required token permissions: ads_read, ads_management, leads_retrieval,
 * pages_show_list, pages_manage_metadata, business_management.
 */

const config = require('../config');

const BASE = 'https://graph.facebook.com';

async function graph(path, { method = 'GET', params = {}, body = null } = {}) {
  const url = new URL(`${BASE}/${config.meta.apiVersion}/${path.replace(/^\//, '')}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  });
  url.searchParams.set('access_token', config.meta.accessToken);

  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const err = data.error || {};
    const e = new Error(err.error_user_msg || err.message || `Meta API ${res.status}`);
    e.status = res.status;
    e.metaCode = err.code;
    e.metaSubcode = err.error_subcode;
    e.hint = hintFor(err);
    throw e;
  }
  return data;
}

function hintFor(err) {
  const code = err.code;
  if (code === 190) return 'Access token expired or revoked. Generate a new long-lived token in Business Settings.';
  if (code === 200 || code === 10) return 'Token is missing a permission. Add ads_read, ads_management and leads_retrieval.';
  if (code === 100) return 'Check the ad account ID — it should look like act_1234567890.';
  if (code === 17 || code === 613) return 'Rate limited by Meta. The console will retry on the next refresh.';
  return '';
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const INSIGHT_FIELDS = [
  'campaign_id', 'campaign_name', 'impressions', 'reach', 'frequency', 'clicks',
  'ctr', 'cpc', 'cpm', 'spend', 'actions', 'cost_per_action_type',
  'video_thruplay_watched_actions', 'date_start', 'date_stop',
].join(',');

async function listCampaigns({ limit = 50 } = {}) {
  if (config.demo.meta) return demo.campaigns();
  const data = await graph(`${config.meta.adAccountId}/campaigns`, {
    params: {
      fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time',
      limit,
    },
  });
  return (data.data || []).map(mapCampaign);
}

async function campaignInsights({ datePreset = 'last_30d', level = 'campaign' } = {}) {
  if (config.demo.meta) return demo.insights(datePreset);
  const data = await graph(`${config.meta.adAccountId}/insights`, {
    params: {
      level,
      fields: INSIGHT_FIELDS,
      date_preset: datePreset,
      time_increment: 1,
      limit: 500,
    },
  });
  return (data.data || []).map(mapInsight);
}

async function accountSummary({ datePreset = 'last_30d' } = {}) {
  const rows = await campaignInsights({ datePreset });
  return rollup(rows);
}

async function listLeadForms() {
  if (config.demo.meta) return demo.forms();
  if (!config.meta.pageId) return [];
  const data = await graph(`${config.meta.pageId}/leadgen_forms`, {
    params: { fields: 'id,name,status,leads_count', limit: 100 },
  });
  return data.data || [];
}

/** Pull new leads submitted through a Meta lead-ad form. */
async function fetchFormLeads(formId, since) {
  if (config.demo.meta) return demo.formLeads();
  const params = { fields: 'id,created_time,field_data,campaign_name,campaign_id,ad_name', limit: 200 };
  if (since) params.filtering = [{ field: 'time_created', operator: 'GREATER_THAN', value: Math.floor(new Date(since) / 1000) }];
  const data = await graph(`${formId}/leads`, { params });
  return (data.data || []).map(mapLeadgen);
}

async function fetchLeadById(leadgenId) {
  if (config.demo.meta) return demo.formLeads()[0];
  const data = await graph(leadgenId, {
    params: { fields: 'id,created_time,field_data,campaign_name,campaign_id,ad_name,form_id' },
  });
  return mapLeadgen(data);
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Create a full campaign in one call: campaign -> ad set -> creative -> ad.
 * Everything is created PAUSED so nobody accidentally spends money from a
 * dashboard click. The client reviews it in Ads Manager, then flips it live
 * from the console.
 */
async function createCampaign(input) {
  const {
    name, objective = 'OUTCOME_LEADS', dailyBudget = 50000,
    targeting = {}, adCopy = {}, leadFormId, pageId, startTime, endTime,
  } = input;

  if (config.demo.meta) return demo.createdCampaign(input);

  const campaign = await graph(`${config.meta.adAccountId}/campaigns`, {
    method: 'POST',
    params: {
      name,
      objective,
      status: 'PAUSED',
      special_ad_categories: JSON.stringify(input.specialAdCategories || ['HOUSING']),
      buying_type: 'AUCTION',
    },
  });

  const geo = targeting.cities?.length
    ? { cities: targeting.cities.map((key) => ({ key, radius: targeting.radiusKm || 15, distance_unit: 'kilometer' })) }
    : { countries: targeting.countries || ['IN'] };

  const adset = await graph(`${config.meta.adAccountId}/adsets`, {
    method: 'POST',
    params: {
      name: `${name} — Ad set`,
      campaign_id: campaign.id,
      daily_budget: dailyBudget,
      billing_event: 'IMPRESSIONS',
      optimization_goal: objective === 'OUTCOME_LEADS' ? 'LEAD_GENERATION' : 'LINK_CLICKS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      destination_type: leadFormId ? 'ON_AD' : 'WEBSITE',
      promoted_object: leadFormId
        ? { page_id: pageId || config.meta.pageId, lead_gen_form_id: leadFormId }
        : { page_id: pageId || config.meta.pageId },
      targeting: JSON.stringify({
        geo_locations: geo,
        age_min: targeting.ageMin || 25,
        age_max: targeting.ageMax || 60,
        publisher_platforms: targeting.platforms || ['facebook', 'instagram'],
        flexible_spec: targeting.interests?.length
          ? [{ interests: targeting.interests.map((id) => ({ id })) }] : undefined,
      }),
      status: 'PAUSED',
      start_time: startTime,
      end_time: endTime,
    },
  });

  const creative = await graph(`${config.meta.adAccountId}/adcreatives`, {
    method: 'POST',
    params: {
      name: `${name} — Creative`,
      object_story_spec: JSON.stringify({
        page_id: pageId || config.meta.pageId,
        link_data: {
          message: adCopy.primaryText || '',
          name: adCopy.headline || name,
          description: adCopy.description || '',
          link: adCopy.link || `https://facebook.com/${pageId || config.meta.pageId}`,
          image_hash: adCopy.imageHash,
          call_to_action: {
            type: adCopy.cta || 'LEARN_MORE',
            value: leadFormId ? { lead_gen_form_id: leadFormId } : { link: adCopy.link },
          },
        },
      }),
    },
  });

  const ad = await graph(`${config.meta.adAccountId}/ads`, {
    method: 'POST',
    params: {
      name: `${name} — Ad`,
      adset_id: adset.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: 'PAUSED',
    },
  });

  return { campaignId: campaign.id, adsetId: adset.id, creativeId: creative.id, adId: ad.id, status: 'PAUSED' };
}

async function setCampaignStatus(campaignId, status) {
  if (config.demo.meta) return { id: campaignId, status, demo: true };
  await graph(campaignId, { method: 'POST', params: { status } });
  return { id: campaignId, status };
}

async function updateBudget(campaignId, dailyBudget) {
  if (config.demo.meta) return { id: campaignId, daily_budget: dailyBudget, demo: true };
  await graph(campaignId, { method: 'POST', params: { daily_budget: dailyBudget } });
  return { id: campaignId, daily_budget: dailyBudget };
}

/* ------------------------------------------------------------------ */
/* Mapping and maths                                                   */
/* ------------------------------------------------------------------ */

function mapCampaign(c) {
  return {
    id: c.id,
    name: c.name,
    status: c.effective_status || c.status,
    objective: c.objective,
    dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
    lifetimeBudget: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
    startTime: c.start_time,
    createdTime: c.created_time,
  };
}

function actionValue(actions, type) {
  if (!Array.isArray(actions)) return 0;
  const hit = actions.find((a) => a.action_type === type);
  return hit ? Number(hit.value) : 0;
}

function mapInsight(r) {
  const leads = actionValue(r.actions, 'lead')
    || actionValue(r.actions, 'onsite_conversion.lead_grouped')
    || actionValue(r.actions, 'offsite_conversion.fb_pixel_lead');
  const spend = Number(r.spend || 0);
  return {
    date: r.date_start,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    impressions: Number(r.impressions || 0),
    reach: Number(r.reach || 0),
    frequency: Number(r.frequency || 0),
    clicks: Number(r.clicks || 0),
    ctr: Number(r.ctr || 0),
    cpc: Number(r.cpc || 0),
    cpm: Number(r.cpm || 0),
    spend,
    leads,
    videoViews: actionValue(r.video_thruplay_watched_actions, 'video_view'),
    messagingStarted: actionValue(r.actions, 'onsite_conversion.messaging_conversation_started_7d'),
    costPerLead: leads ? spend / leads : 0,
  };
}

function mapLeadgen(l) {
  const fields = {};
  (l.field_data || []).forEach((f) => { fields[f.name] = (f.values || [])[0]; });
  return {
    externalId: l.id,
    createdAt: l.created_time,
    campaignId: l.campaign_id || null,
    campaignName: l.campaign_name || null,
    adName: l.ad_name || null,
    fullName: fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: fields.phone_number || fields.phone || null,
    email: fields.email || null,
    city: fields.city || fields.locality || null,
    budget: fields.budget || fields.budget_range || null,
    propertyType: fields.property_type || fields.configuration || null,
    timeline: fields.timeline || fields.when_are_you_planning_to_buy || null,
    raw: fields,
  };
}

function rollup(rows) {
  const total = rows.reduce((a, r) => ({
    impressions: a.impressions + r.impressions,
    reach: a.reach + r.reach,
    clicks: a.clicks + r.clicks,
    spend: a.spend + r.spend,
    leads: a.leads + r.leads,
    videoViews: a.videoViews + r.videoViews,
  }), { impressions: 0, reach: 0, clicks: 0, spend: 0, leads: 0, videoViews: 0 });

  const byDay = {};
  rows.forEach((r) => {
    if (!byDay[r.date]) byDay[r.date] = { date: r.date, spend: 0, leads: 0, clicks: 0, impressions: 0 };
    byDay[r.date].spend += r.spend;
    byDay[r.date].leads += r.leads;
    byDay[r.date].clicks += r.clicks;
    byDay[r.date].impressions += r.impressions;
  });

  const byCampaign = {};
  rows.forEach((r) => {
    const k = r.campaignId || r.campaignName || 'unknown';
    if (!byCampaign[k]) {
      byCampaign[k] = {
        campaignId: r.campaignId, campaignName: r.campaignName,
        spend: 0, leads: 0, clicks: 0, impressions: 0, reach: 0,
      };
    }
    const c = byCampaign[k];
    c.spend += r.spend; c.leads += r.leads; c.clicks += r.clicks;
    c.impressions += r.impressions; c.reach = Math.max(c.reach, r.reach);
  });

  Object.values(byCampaign).forEach((c) => {
    c.ctr = c.impressions ? (c.clicks / c.impressions) * 100 : 0;
    c.cpc = c.clicks ? c.spend / c.clicks : 0;
    c.costPerLead = c.leads ? c.spend / c.leads : 0;
  });

  return {
    totals: {
      ...total,
      ctr: total.impressions ? (total.clicks / total.impressions) * 100 : 0,
      cpc: total.clicks ? total.spend / total.clicks : 0,
      cpm: total.impressions ? (total.spend / total.impressions) * 1000 : 0,
      costPerLead: total.leads ? total.spend / total.leads : 0,
    },
    daily: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)),
    campaigns: Object.values(byCampaign).sort((a, b) => b.spend - a.spend),
  };
}

/* ------------------------------------------------------------------ */
/* Sample data (used until a real token is configured)                 */
/* ------------------------------------------------------------------ */

const demo = {
  campaigns() {
    return [
      { id: '238100011', name: 'Kharadi 3BHK — Site Visit', status: 'ACTIVE', objective: 'OUTCOME_LEADS', dailyBudget: 1800, startTime: iso(-28), createdTime: iso(-30) },
      { id: '238100012', name: 'Wakad 2BHK — Ready Possession', status: 'ACTIVE', objective: 'OUTCOME_LEADS', dailyBudget: 1200, startTime: iso(-21), createdTime: iso(-22) },
      { id: '238100013', name: 'Baner Retargeting — Video Viewers', status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC', dailyBudget: 700, startTime: iso(-14), createdTime: iso(-15) },
      { id: '238100014', name: 'Hinjawadi 1BHK — First Home', status: 'PAUSED', objective: 'OUTCOME_LEADS', dailyBudget: 900, startTime: iso(-40), createdTime: iso(-41) },
    ];
  },

  insights(preset) {
    const days = preset === 'last_7d' ? 7 : preset === 'today' ? 1 : preset === 'last_90d' ? 90 : 30;
    const camps = demo.campaigns().filter((c) => c.status === 'ACTIVE');
    const rows = [];
    for (let d = days - 1; d >= 0; d--) {
      camps.forEach((c, ci) => {
        const wobble = 0.72 + ((d * 7 + ci * 13) % 11) / 18;
        const weekend = [0, 6].includes(new Date(Date.now() - d * 86400000).getDay()) ? 1.22 : 1;
        const spend = Math.round(c.dailyBudget * wobble * weekend);
        const impressions = Math.round(spend * (54 + ci * 7));
        const clicks = Math.round(impressions * (0.011 + ci * 0.003));
        const leads = Math.max(0, Math.round(clicks * (0.14 + ci * 0.02)));
        rows.push({
          date: iso(-d).slice(0, 10),
          campaignId: c.id,
          campaignName: c.name,
          impressions,
          reach: Math.round(impressions * 0.72),
          frequency: 1.38,
          clicks,
          ctr: (clicks / impressions) * 100,
          cpc: clicks ? spend / clicks : 0,
          cpm: (spend / impressions) * 1000,
          spend,
          leads,
          videoViews: Math.round(impressions * 0.21),
          messagingStarted: Math.round(leads * 0.4),
          costPerLead: leads ? spend / leads : 0,
        });
      });
    }
    return rows;
  },

  forms() {
    return [
      { id: '7781000221', name: 'Kharadi 3BHK enquiry', status: 'ACTIVE', leads_count: 184 },
      { id: '7781000222', name: 'Wakad possession enquiry', status: 'ACTIVE', leads_count: 96 },
    ];
  },

  formLeads() {
    return [{
      externalId: 'lg_demo_' + Date.now(),
      createdAt: new Date().toISOString(),
      campaignId: '238100011',
      campaignName: 'Kharadi 3BHK — Site Visit',
      adName: 'Carousel — floor plans',
      fullName: 'Demo Lead',
      phone: '+91900000' + Math.floor(1000 + Math.random() * 8999),
      email: 'demo.lead@example.com',
      city: 'Kharadi',
      budget: '90-1cr',
      propertyType: '3BHK',
      timeline: '1-3 months',
      raw: {},
    }];
  },

  createdCampaign(input) {
    const id = String(239000000 + Math.floor(Math.random() * 999999));
    return {
      campaignId: id,
      adsetId: id + '01',
      creativeId: id + '02',
      adId: id + '03',
      status: 'PAUSED',
      demo: true,
      note: 'Sample mode — nothing was sent to Meta. Add META_ACCESS_TOKEN to create for real.',
      echo: input,
    };
  },
};

function iso(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString();
}

module.exports = {
  graph,
  listCampaigns,
  campaignInsights,
  accountSummary,
  listLeadForms,
  fetchFormLeads,
  fetchLeadById,
  createCampaign,
  setCampaignStatus,
  updateBudget,
  rollup,
  mapLeadgen,
};
