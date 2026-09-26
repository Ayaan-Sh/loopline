'use strict';

/**
 * One data layer, two backends.
 *
 * With SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set, everything reads and
 * writes Postgres through Supabase. Without them, the same API is served from
 * memory with seeded sample data, so the console is demo-able the moment it
 * starts. Nothing else in the codebase knows which one is active.
 */

const config = require('../config');

const LEADS = 'leads';
const MESSAGES = 'lead_messages';
const ACTIVITY = 'lead_activity';
const TASKS = 'followup_tasks';

let client = null;
if (!config.demo.db) {
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false },
  });
}

/* ------------------------------------------------------------------ */
/* In-memory backend                                                   */
/* ------------------------------------------------------------------ */

const mem = { leads: [], messages: [], activity: [], tasks: [] };
let seq = 1;
const uid = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function seed() {
  const samples = [
    {
      full_name: 'Aditi Kulkarni', phone: '+919822010045', email: 'aditi.k@example.com',
      source: 'meta_lead_ad', campaign_name: 'Kharadi 3BHK — Site Visit',
      property_type: '3BHK', locality: 'Kharadi', budget: 9500000, timeline: '30d',
      stage: 'QUALIFIED', score: 0, consent: true, created_at: daysAgo(2),
      last_contact_at: daysAgo(0), notes: 'Pre-approved loan, wants a weekend visit.',
    },
    {
      full_name: 'Rohit Deshmukh', phone: '+919730114477', email: 'rohit.d@example.com',
      source: 'meta_lead_ad', campaign_name: 'Wakad 2BHK — Ready Possession',
      property_type: '2BHK', locality: 'Wakad', budget: 6200000, timeline: '90d',
      stage: 'ENGAGED', score: 0, consent: true, created_at: daysAgo(5),
      last_contact_at: daysAgo(1), notes: 'Comparing two projects.',
    },
    {
      full_name: 'Sneha Patil', phone: '+919011223344', email: 'sneha.patil@example.com',
      source: 'website', campaign_name: null,
      property_type: '1BHK', locality: 'Hinjawadi', budget: 3800000, timeline: '180d',
      stage: 'WORKING', score: 0, consent: true, created_at: daysAgo(9),
      last_contact_at: daysAgo(6), notes: 'Budget below current inventory.',
    },
    {
      full_name: 'Imran Shaikh', phone: '+919665778899', email: '',
      source: 'outbound_list', campaign_name: null,
      property_type: null, locality: 'Baner', budget: null, timeline: null,
      stage: 'NEW', score: 0, consent: false, created_at: daysAgo(1),
      last_contact_at: null, notes: '',
    },
    {
      full_name: 'Meera Nair', phone: '+919845221100', email: 'meera.nair@example.com',
      source: 'referral', campaign_name: null,
      property_type: '4BHK', locality: 'Koregaon Park', budget: 21000000, timeline: '30d',
      stage: 'SV_BOOKED', score: 0, consent: true, created_at: daysAgo(3),
      last_contact_at: daysAgo(0), notes: 'Visit booked Saturday 11am.',
    },
  ];

  samples.forEach((s) => {
    const lead = { id: uid('lead'), updated_at: s.created_at, attempts: 0, ...s };
    mem.leads.push(lead);
  });

  const hot = mem.leads[0];
  pushMessage(hot.id, 'inbound', 'whatsapp', 'Hi, saw the Kharadi ad. What is the price for a 3BHK?', daysAgo(2));
  pushMessage(hot.id, 'outbound', 'whatsapp', 'Hi Aditi — 3BHKs in Kharadi start at 92L. What budget are you working with?', daysAgo(2));
  pushMessage(hot.id, 'inbound', 'whatsapp', 'Around 95 lakh. Loan is already approved. Can I visit this Saturday?', daysAgo(0));

  const warm = mem.leads[1];
  pushMessage(warm.id, 'inbound', 'sms', 'Is the Wakad project ready to move in?', daysAgo(5));
  pushMessage(warm.id, 'outbound', 'sms', 'Yes, possession is immediate. Are you looking within 3 months?', daysAgo(5));
  pushMessage(warm.id, 'inbound', 'sms', 'Maybe in 2-3 months, still comparing options.', daysAgo(1));
}

function pushMessage(lead_id, direction, channel, body, at) {
  mem.messages.push({
    id: uid('msg'), lead_id, direction, channel, body,
    created_at: at || new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function sortDesc(rows, key) {
  return rows.slice().sort((a, b) => String(b[key] || '').localeCompare(String(a[key] || '')));
}

async function sb(table) {
  return client.from(table);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const store = {
  mode: config.demo.db ? 'memory' : 'supabase',

  async listLeads({ stage, band, search, limit = 200 } = {}) {
    let rows;
    if (client) {
      let q = (await sb(LEADS)).select('*').order('created_at', { ascending: false }).limit(limit);
      if (stage) q = q.eq('stage', stage);
      const { data, error } = await q;
      if (error) throw error;
      rows = data || [];
    } else {
      rows = sortDesc(mem.leads, 'created_at');
      if (stage) rows = rows.filter((l) => l.stage === stage);
      rows = rows.slice(0, limit);
    }
    if (band) rows = rows.filter((l) => (l.band || '').toLowerCase() === band.toLowerCase());
    if (search) {
      const s = search.toLowerCase();
      rows = rows.filter((l) =>
        [l.full_name, l.phone, l.email, l.locality, l.campaign_name]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(s)));
    }
    return rows;
  },

  async getLead(id) {
    if (client) {
      const { data, error } = await (await sb(LEADS)).select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    }
    return mem.leads.find((l) => l.id === id) || null;
  },

  async findLeadByPhone(phone) {
    if (!phone) return null;
    if (client) {
      const { data, error } = await (await sb(LEADS)).select('*').eq('phone', phone).maybeSingle();
      if (error) throw error;
      return data || null;
    }
    return mem.leads.find((l) => l.phone === phone) || null;
  },

  async createLead(payload) {
    const now = new Date().toISOString();
    const row = {
      full_name: payload.full_name || 'Unknown',
      phone: payload.phone || null,
      email: payload.email || null,
      source: payload.source || 'manual',
      campaign_name: payload.campaign_name || null,
      campaign_id: payload.campaign_id || null,
      property_type: payload.property_type || null,
      locality: payload.locality || null,
      budget: payload.budget ?? null,
      timeline: payload.timeline || null,
      stage: payload.stage || 'NEW',
      score: payload.score ?? 0,
      band: payload.band || 'COLD',
      consent: payload.consent ?? false,
      notes: payload.notes || '',
      attempts: 0,
      external_id: payload.external_id || null,
      created_at: now,
      updated_at: now,
      last_contact_at: payload.last_contact_at || null,
    };
    if (client) {
      const { data, error } = await (await sb(LEADS)).insert(row).select().single();
      if (error) throw error;
      return data;
    }
    row.id = uid('lead');
    mem.leads.push(row);
    return row;
  },

  async updateLead(id, patch) {
    const next = { ...patch, updated_at: new Date().toISOString() };
    if (client) {
      const { data, error } = await (await sb(LEADS)).update(next).eq('id', id).select().single();
      if (error) throw error;
      return data;
    }
    const lead = mem.leads.find((l) => l.id === id);
    if (!lead) return null;
    Object.assign(lead, next);
    return lead;
  },

  async deleteLead(id) {
    if (client) {
      const { error } = await (await sb(LEADS)).delete().eq('id', id);
      if (error) throw error;
      return true;
    }
    const i = mem.leads.findIndex((l) => l.id === id);
    if (i >= 0) mem.leads.splice(i, 1);
    return true;
  },

  async listMessages(leadId) {
    if (client) {
      const { data, error } = await (await sb(MESSAGES))
        .select('*').eq('lead_id', leadId).order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    }
    return mem.messages
      .filter((m) => m.lead_id === leadId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  },

  async addMessage({ lead_id, direction, channel, body, meta }) {
    const row = {
      lead_id, direction, channel, body,
      meta: meta || null,
      created_at: new Date().toISOString(),
    };
    if (client) {
      const { data, error } = await (await sb(MESSAGES)).insert(row).select().single();
      if (error) throw error;
      return data;
    }
    row.id = uid('msg');
    mem.messages.push(row);
    return row;
  },

  async logActivity({ lead_id, type, channel, summary, actor }) {
    const row = {
      lead_id, type, channel: channel || null,
      summary: summary || '', actor: actor || 'console',
      created_at: new Date().toISOString(),
    };
    if (client) {
      const { data, error } = await (await sb(ACTIVITY)).insert(row).select().single();
      if (error) throw error;
      return data;
    }
    row.id = uid('act');
    mem.activity.push(row);
    return row;
  },

  async listActivity(leadId, limit = 50) {
    if (client) {
      const { data, error } = await (await sb(ACTIVITY))
        .select('*').eq('lead_id', leadId).order('created_at', { ascending: false }).limit(limit);
      if (error) throw error;
      return data || [];
    }
    return sortDesc(mem.activity.filter((a) => a.lead_id === leadId), 'created_at').slice(0, limit);
  },

  async upsertTask({ lead_id, due_at, step, channel, body }) {
    const row = {
      lead_id, due_at, step, channel, body,
      status: 'pending', created_at: new Date().toISOString(),
    };
    if (client) {
      const { data, error } = await (await sb(TASKS)).insert(row).select().single();
      if (error) throw error;
      return data;
    }
    row.id = uid('task');
    mem.tasks.push(row);
    return row;
  },

  async dueTasks(now = new Date()) {
    const iso = now.toISOString();
    if (client) {
      const { data, error } = await (await sb(TASKS))
        .select('*').eq('status', 'pending').lte('due_at', iso).limit(100);
      if (error) throw error;
      return data || [];
    }
    return mem.tasks.filter((t) => t.status === 'pending' && t.due_at <= iso);
  },

  async closeTask(id, status = 'sent') {
    if (client) {
      const { error } = await (await sb(TASKS)).update({ status }).eq('id', id);
      if (error) throw error;
      return true;
    }
    const t = mem.tasks.find((x) => x.id === id);
    if (t) t.status = status;
    return true;
  },

  async cancelTasksFor(leadId) {
    if (client) {
      const { error } = await (await sb(TASKS))
        .update({ status: 'cancelled' }).eq('lead_id', leadId).eq('status', 'pending');
      if (error) throw error;
      return true;
    }
    mem.tasks.forEach((t) => {
      if (t.lead_id === leadId && t.status === 'pending') t.status = 'cancelled';
    });
    return true;
  },
};

if (!client) seed();

module.exports = store;
