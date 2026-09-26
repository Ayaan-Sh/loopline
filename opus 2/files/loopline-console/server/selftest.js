'use strict';

/**
 * End-to-end smoke test. Run `npm run check` after any change, and before any
 * handover — it walks the same path a client would: see the dashboard data,
 * create a lead, let the bot qualify it, send outreach, run the cadence.
 */

const app = require('./index');

let pass = 0, fail = 0;
const results = [];

function check(name, condition, detail) {
  if (condition) { pass++; results.push(`  ok    ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

async function run() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, options = {}) => {
    const res = await fetch(base + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // 1. Health
  const health = await call('/api/health');
  check('health responds', health.status === 200 && health.body.ok);
  check('integration status reported', !!health.body.integrations);

  // 2. Meta reads
  const overview = await call('/api/meta/overview?range=last_30d');
  check('ads overview returns totals', overview.status === 200 && overview.body.totals.spend > 0);
  check('daily series present', (overview.body.daily || []).length > 0);
  check('campaign breakdown present', (overview.body.campaigns || []).length > 0);
  check('cost per lead computed', overview.body.totals.costPerLead > 0);

  const campaigns = await call('/api/meta/campaigns');
  check('campaigns list', campaigns.body.campaigns.length > 0);

  // 3. Meta writes
  const created = await call('/api/meta/campaigns', {
    method: 'POST',
    body: { name: 'Test — Wakad 2BHK', dailyBudget: 1500, headline: 'Ready homes', primaryText: 'Book a visit' },
  });
  check('campaign creation returns ids', created.status === 201 && !!created.body.campaignId);
  check('campaigns are created paused', created.body.status === 'PAUSED');

  const badBudget = await call('/api/meta/campaigns', { method: 'POST', body: { name: 'x', dailyBudget: 5 } });
  check('rejects an unusable budget', badBudget.status === 400);

  const toggled = await call(`/api/meta/campaigns/${created.body.campaignId}/status`, {
    method: 'POST', body: { status: 'ACTIVE' },
  });
  check('campaign status can be changed', toggled.status === 200);

  // 4. Leads
  const list = await call('/api/leads');
  check('lead list loads', list.status === 200 && list.body.leads.length > 0);
  check('leads are scored', list.body.leads.every((l) => typeof l.score === 'number' && l.band));
  check('leads sorted hottest first', list.body.leads[0].score >= list.body.leads[list.body.leads.length - 1].score);
  check('summary counts bands', typeof list.body.summary.hot === 'number');

  const hot = list.body.leads.find((l) => l.band === 'HOT');
  check('a ready buyer scores hot', !!hot, 'seeded buyer with approved loan and a visit request should be HOT');

  const cold = list.body.leads.find((l) => l.band === 'COLD');
  check('an unqualified lead scores cold', !!cold);

  const newLead = await call('/api/leads', {
    method: 'POST',
    body: {
      full_name: 'Test Buyer', phone: '+919000000001', email: 'test@example.com',
      source: 'website', locality: 'Baner', budget: 8500000, property_type: '3BHK',
      timeline: '30d', consent: true,
    },
  });
  check('lead creation works', newLead.status === 201 && newLead.body.lead.id);
  const leadId = newLead.body.lead.id;

  const dupe = await call('/api/leads', { method: 'POST', body: { phone: '+919000000001' } });
  check('duplicate phone is refused', dupe.status === 409);

  const noContact = await call('/api/leads', { method: 'POST', body: { full_name: 'No Contact' } });
  check('lead without phone or email is refused', noContact.status === 400);

  // 5. Bot understanding
  const analyse = await call('/api/chat/analyse', {
    method: 'POST',
    body: { text: 'Budget is around 95 lakh, loan pre-approved. Can I visit the Kharadi site on Saturday?' },
  });
  check('bot detects a visit request', analyse.body.intent === 'schedule_visit');
  check('bot extracts budget', analyse.body.extracted.budget === 9500000);
  check('bot extracts locality', analyse.body.extracted.locality === 'Kharadi');

  const optOut = await call('/api/chat/analyse', { method: 'POST', body: { text: 'Not interested, stop messaging' } });
  check('opt-out lands cold', optOut.body.band === 'COLD');

  // 6. Bot conversation against a real lead
  const reply = await call('/api/chat/reply', {
    method: 'POST',
    body: { leadId, text: 'Yes still looking. Budget 95 lakh, want to see it this Saturday.' },
  });
  check('bot replies', reply.status === 200 && typeof reply.body.reply === 'string' && reply.body.reply.length > 0);
  check('conversation raises the score', reply.body.score >= newLead.body.lead.score);
  check('hot conversation advances the stage', ['QUALIFIED', 'SV_BOOKED', 'ENGAGED'].includes(reply.body.lead.stage));

  const detail = await call('/api/leads/' + leadId);
  check('conversation is stored', detail.body.messages.length >= 2);
  check('activity is logged', detail.body.activity.length >= 1);

  // 7. Outreach
  for (const channel of ['whatsapp', 'email', 'sms', 'call']) {
    const d = await call(`/api/outreach/draft/${leadId}?channel=${channel}`);
    check(`${channel} draft is written`, d.status === 200 && d.body.body && d.body.body.length > 20);
  }

  const send = await call('/api/outreach/send', { method: 'POST', body: { leadId, channel: 'whatsapp' } });
  const quiet = send.status === 409 && send.body.code === 'QUIET_HOURS';
  check('outreach sends (or is held for quiet hours)', send.status === 200 || quiet, JSON.stringify(send.body).slice(0, 120));

  const ladder = await call('/api/outreach/ladder/' + leadId, { method: 'POST', body: {} });
  check('follow-up cadence queues', ladder.status === 200 && ladder.body.queued > 0);
  check('cadence is paced by temperature', ladder.body.queued <= 7);

  const run = await call('/api/outreach/run', { method: 'POST', body: {} });
  check('due follow-ups process', run.status === 200 && typeof run.body.sent === 'number');

  // 8. Opt-out kills the pipeline
  const stop = await call('/api/chat/reply', { method: 'POST', body: { leadId, text: 'Please stop, not interested' } });
  check('opt-out marks do-not-contact', stop.body.lead.stage === 'DNC');
  const blocked = await call('/api/outreach/send', { method: 'POST', body: { leadId, channel: 'whatsapp' } });
  check('sending to a DNC lead is refused', blocked.status === 409);

  // 9. Meta lead sync + rescore
  const sync = await call('/api/leads/sync/meta', { method: 'POST', body: {} });
  check('meta lead sync runs', sync.status === 200 && sync.body.ok);

  const rescore = await call('/api/leads/rescore', { method: 'POST', body: {} });
  check('bulk rescore runs', rescore.status === 200 && rescore.body.rescored > 0);

  const imported = await call('/api/leads/import', {
    method: 'POST',
    body: { rows: [{ full_name: 'List A', phone: '+919000000091' }, { full_name: 'No contact detail' }] },
  });
  check('bulk import accepts good rows and skips bad ones', imported.body.imported === 1 && imported.body.skipped === 1);

  // 10. Cleanup
  const del = await call('/api/leads/' + leadId, { method: 'DELETE' });
  check('lead deletion works', del.status === 200);

  const missing = await call('/api/leads/does-not-exist');
  check('unknown lead returns 404', missing.status === 404);

  server.close();

  console.log('\nLoopline Console — self test\n');
  console.log(results.join('\n'));
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
