/* Loopline Console — front end. No build step, no framework. */

const API = '/api';
const state = {
  health: null,
  overview: null,
  leads: [],
  summary: null,
  filters: { band: '', stage: '', search: '' },
  openLead: null,
  forms: [],
};

/* ------------------------------------------------------------------ */
/* Plumbing                                                            */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(n, compact = false) {
  const v = Number(n || 0);
  if (compact && v >= 10000000) return '₹' + (v / 10000000).toFixed(2) + ' Cr';
  if (compact && v >= 100000) return '₹' + (v / 100000).toFixed(1) + ' L';
  if (compact && v >= 1000) return '₹' + (v / 1000).toFixed(1) + 'k';
  return '₹' + Math.round(v).toLocaleString('en-IN');
}

function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

function ago(iso) {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const h = Math.floor(mins / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d + 'd ago';
}

let toastTimer;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:80;
    border:1px solid ${bad ? 'var(--coral)' : 'var(--amber-deep)'};border-radius:8px;padding:10px 16px;font-size:13.5px;font-weight:500;
    box-shadow:0 16px 32px -16px rgba(18,18,26,.35);background:${bad ? 'var(--coral-tint)' : 'var(--amber-tint)'};color:${bad ? 'var(--coral)' : 'var(--amber-deep)'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3600);
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

$$('.rail-link').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.rail-link').forEach((b) => b.classList.toggle('is-current', b === btn));
    $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + btn.dataset.view));
    if (btn.dataset.view === 'campaigns') loadCampaigns();
    if (btn.dataset.view === 'leads') loadLeads();
  });
});

$('#themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.getAttribute('data-theme') === 'dark';
  if (dark) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', 'dark');
  try { localStorage.setItem('loopline_console_theme', dark ? 'light' : 'dark'); } catch (e) {}
  if (state.overview) drawChart(state.overview.daily);
});

try {
  if (localStorage.getItem('loopline_console_theme') === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
} catch (e) {}

$$('[data-close-form]').forEach((b) => {
  b.addEventListener('click', () => { b.closest('.form-panel').hidden = true; });
});

/* ------------------------------------------------------------------ */
/* Health + setup                                                      */
/* ------------------------------------------------------------------ */

async function loadHealth() {
  const h = await api('/health');
  state.health = h;
  const i = h.integrations;
  $('#railMode').textContent = `${i.metaAds} · ${i.database}\n${i.bot}`;
  $('#sampleBanner').hidden = !(i.metaAds === 'sample data');

  const cards = [
    { title: 'Meta Ads', live: i.metaAds === 'live', on: 'Pulling live spend and leads from your ad account.', off: 'Showing sample campaigns. Add META_ACCESS_TOKEN and META_AD_ACCOUNT_ID.' },
    { title: 'Database', live: i.database === 'supabase', on: 'Leads are saved to Supabase.', off: 'Leads live in memory and clear on restart. Add your Supabase URL and service key.' },
    { title: 'Email', live: i.email === 'smtp', on: 'Emails send through your SMTP server.', off: 'Emails are simulated so you can test the flow. Add SMTP details to send.' },
    { title: 'Calls and WhatsApp', live: i.telephony === 'twilio', on: 'Calls and messages go through Twilio.', off: 'Calls and messages are simulated. Add Twilio credentials to go live.' },
    { title: 'Qualification bot', live: true, on: `Running on ${i.bot}. No third-party chatbot service involved.`, off: '' },
  ];

  $('#statusGrid').innerHTML = cards.map((c) => `
    <div class="status ${c.live ? 'is-live' : ''}">
      <h3>${esc(c.title)}</h3>
      <p>${esc(c.live ? c.on : c.off)}</p>
    </div>`).join('');

  $('#weights').innerHTML = [
    ['25', 'Budget fit', 'against the cheapest unit you can sell'],
    ['20', 'Timeline', 'how soon they say they will buy'],
    ['20', 'Intent', 'phrases like site visit, loan approved, booking'],
    ['15', 'Engagement', 'how often and how fast they reply'],
    ['10', 'Completeness', 'how many of the five fields are filled'],
    ['10', 'Source', 'referral beats lead ad beats cold list'],
    ['−', 'Penalties', 'opt-outs, silence, no consent, stale leads'],
  ].map(([n, label, sub]) => `
    <div class="weight"><strong>${n}</strong><span>${esc(label)} — ${esc(sub)}</span></div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

async function loadOverview() {
  const range = $('#rangeSelect').value;
  const data = await api('/meta/overview?range=' + range);
  state.overview = data;

  const t = data.totals;
  const kpis = [
    { label: 'Spend', value: money(t.spend, true), sub: `${money(t.cpc)} per click`, accent: true },
    { label: 'Leads', value: num(t.leads), sub: `${money(t.costPerLead)} per lead` },
    { label: 'People reached', value: num(t.reach), sub: `${num(t.impressions)} impressions` },
    { label: 'Click-through rate', value: t.ctr.toFixed(2) + '%', sub: `${num(t.clicks)} clicks` },
    { label: 'Qualified from ads', value: num(data.pipeline.qualified), sub: `${data.pipeline.qualificationRate.toFixed(0)}% of ad leads` },
    { label: 'Cost per qualified lead', value: money(data.pipeline.costPerQualified, true), sub: 'spend ÷ qualified leads' },
  ];
  $('#kpis').innerHTML = kpis.map((k) => `
    <div class="kpi ${k.accent ? 'kpi-accent' : ''}">
      <p class="kpi-label">${esc(k.label)}</p>
      <p class="kpi-value">${esc(k.value)}</p>
      <p class="kpi-sub">${esc(k.sub)}</p>
    </div>`).join('');

  drawChart(data.daily);

  $('#campaignPerf tbody').innerHTML = data.campaigns.length ? data.campaigns.map((c) => `
    <tr>
      <td class="strong-cell">${esc(c.campaignName || 'Unnamed')}
        <div class="cell-sub">${esc(c.status || '')}</div></td>
      <td class="num">${money(c.spend, true)}</td>
      <td class="num">${num(c.impressions)}</td>
      <td class="num">${num(c.clicks)}</td>
      <td class="num">${c.ctr.toFixed(2)}%</td>
      <td class="num">${num(c.leads)}</td>
      <td class="num">${c.leads ? money(c.costPerLead) : '—'}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">No delivery in this window.</td></tr>';
}

function drawChart(daily) {
  const hold = $('#chart');
  if (!daily || !daily.length) { hold.innerHTML = '<p class="empty">No spend recorded in this window.</p>'; return; }

  const W = 720, H = 240, padL = 46, padR = 34, padT = 14, padB = 26;
  const maxSpend = Math.max(...daily.map((d) => d.spend), 1);
  const maxLeads = Math.max(...daily.map((d) => d.leads), 1);
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i) => padL + (daily.length === 1 ? iw / 2 : (i / (daily.length - 1)) * iw);
  const ySpend = (v) => padT + ih - (v / maxSpend) * ih;

  const line = daily.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${ySpend(d.spend).toFixed(1)}`).join(' ');
  const area = `${line} L${x(daily.length - 1).toFixed(1)},${padT + ih} L${x(0).toFixed(1)},${padT + ih} Z`;

  const barW = Math.max(3, Math.min(16, iw / daily.length - 3));
  const bars = daily.map((d, i) => {
    const h = (d.leads / maxLeads) * (ih * 0.55);
    return `<rect x="${(x(i) - barW / 2).toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="var(--teal)" stroke="var(--teal)" stroke-width="1"><title>${d.date}: ${d.leads} leads</title></rect>`;
  }).join('');

  const ticks = [0, 0.5, 1].map((f) => {
    const y = padT + ih - f * ih;
    return `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--line)" stroke-width="1.5"/>
      <text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="11" font-family="IBM Plex Mono, monospace" fill="var(--ink-soft)">${f ? '₹' + Math.round(maxSpend * f / 1000) + 'k' : '0'}</text>`;
  }).join('');

  const step = Math.ceil(daily.length / 6);
  const labels = daily.map((d, i) => (i % step === 0 || i === daily.length - 1)
    ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" font-family="IBM Plex Mono, monospace" fill="var(--ink-soft)">${d.date.slice(5)}</text>` : '').join('');

  const dots = daily.map((d, i) => `<circle cx="${x(i).toFixed(1)}" cy="${ySpend(d.spend).toFixed(1)}" r="3" fill="var(--paper)" stroke="var(--amber-deep)" stroke-width="2"><title>${d.date}: ${money(d.spend)}</title></circle>`).join('');

  hold.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily ad spend with leads generated">
    ${ticks}${bars}
    <path d="${area}" fill="var(--amber-deep)" opacity="0.08"/>
    <path d="${line}" fill="none" stroke="var(--amber-deep)" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${labels}
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

async function loadCampaigns() {
  const [{ campaigns }, { forms }] = await Promise.all([
    api('/meta/campaigns'),
    api('/meta/forms').catch(() => ({ forms: [] })),
  ]);
  state.forms = forms || [];
  $('#leadFormSelect').innerHTML = '<option value="">None — send to website</option>' +
    state.forms.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');

  $('#campaignTable tbody').innerHTML = campaigns.length ? campaigns.map((c) => {
    const live = c.status === 'ACTIVE';
    return `<tr data-id="${esc(c.id)}">
      <td class="strong-cell">${esc(c.name)}<div class="cell-sub num">${esc(c.id)}</div></td>
      <td><span class="badge ${live ? 'badge-live' : 'badge-paused'}">${live ? 'Live' : 'Paused'}</span></td>
      <td class="dim">${esc((c.objective || '').replace('OUTCOME_', '').toLowerCase())}</td>
      <td class="num">${c.dailyBudget ? money(c.dailyBudget) : '—'}</td>
      <td>
        <div class="action-row">
          <button class="btn btn-sm btn-ghost" data-act="toggle" data-status="${live ? 'PAUSED' : 'ACTIVE'}">${live ? 'Pause' : 'Resume'}</button>
          <button class="btn btn-sm btn-ghost" data-act="budget">Budget</button>
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">No campaigns in this ad account yet. Create one above.</td></tr>';
}

$('#campaignTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  try {
    if (btn.dataset.act === 'toggle') {
      await api(`/meta/campaigns/${id}/status`, { method: 'POST', body: { status: btn.dataset.status } });
      toast(btn.dataset.status === 'ACTIVE' ? 'Campaign resumed' : 'Campaign paused');
    } else {
      const value = prompt('New daily budget in rupees:');
      if (!value) return;
      await api(`/meta/campaigns/${id}/budget`, { method: 'POST', body: { dailyBudget: Number(value) } });
      toast('Budget updated');
    }
    loadCampaigns();
  } catch (err) { toast(err.message, true); }
});

$('#newCampaignBtn').addEventListener('click', () => {
  const p = $('#campaignForm');
  p.hidden = !p.hidden;
  if (!p.hidden) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

$('#createCampaign').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#campaignFormNote');
  const body = Object.fromEntries(new FormData(e.target).entries());
  body.dailyBudget = Number(body.dailyBudget);
  body.ageMin = Number(body.ageMin);
  body.ageMax = Number(body.ageMax);
  note.className = 'form-note';
  note.textContent = 'Creating…';
  try {
    const out = await api('/meta/campaigns', { method: 'POST', body });
    note.className = 'form-note is-good';
    note.textContent = out.demo
      ? 'Created in sample mode — nothing was sent to Meta. Add your token to create for real.'
      : `Created paused. Campaign ${out.campaignId}. Review it in Ads Manager, then resume from the table.`;
    e.target.reset();
    loadCampaigns();
  } catch (err) {
    note.className = 'form-note is-bad';
    note.textContent = err.message + (err.data?.hint ? ` — ${err.data.hint}` : '');
  }
});

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

const STAGES = ['NEW', 'WORKING', 'ENGAGED', 'QUALIFIED', 'SV_BOOKED', 'NEGOTIATION', 'WON', 'LOST', 'DNC'];
const STAGE_LABEL = {
  NEW: 'New', WORKING: 'Working', ENGAGED: 'Engaged', QUALIFIED: 'Qualified',
  SV_BOOKED: 'Visit booked', NEGOTIATION: 'Negotiating', WON: 'Won', LOST: 'Lost', DNC: 'Do not contact',
};

$('#stageFilter').innerHTML = '<option value="">Every stage</option>' +
  STAGES.map((s) => `<option value="${s}">${STAGE_LABEL[s]}</option>`).join('');

async function loadLeads() {
  const q = new URLSearchParams();
  if (state.filters.stage) q.set('stage', state.filters.stage);
  if (state.filters.search) q.set('search', state.filters.search);
  const data = await api('/leads?' + q.toString());
  state.leads = data.leads;
  state.summary = data.summary;

  const rows = state.filters.band
    ? data.leads.filter((l) => l.band === state.filters.band)
    : data.leads;

  $('#railLeadCount').textContent = data.summary.hot ? `${data.summary.hot} hot` : '';
  $('#leadEmpty').hidden = rows.length > 0;

  $('#leadTable tbody').innerHTML = rows.map((l) => `
    <tr data-id="${esc(l.id)}">
      <td><span class="score-chip ${l.band === 'HOT' ? 'is-hot' : l.band === 'WARM' ? 'is-warm' : ''}">${l.score}</span></td>
      <td class="strong-cell">${esc(l.full_name)}
        <div class="cell-sub">${esc(l.phone || l.email || '')}${l.locality ? ' · ' + esc(l.locality) : ''}</div></td>
      <td class="dim">${esc((l.source || '').replace(/_/g, ' '))}
        ${l.campaign_name ? `<div class="cell-sub">${esc(l.campaign_name)}</div>` : ''}</td>
      <td class="num">${l.budget ? money(l.budget, true) : '—'}</td>
      <td><span class="badge badge-${l.band.toLowerCase()}">${STAGE_LABEL[l.stage] || l.stage}</span></td>
      <td class="dim num">${ago(l.last_contact_at)}</td>
      <td><button class="btn btn-sm" data-open>Follow up</button></td>
    </tr>`).join('');

  renderFunnel();
}

function renderFunnel() {
  const s = state.summary;
  if (!s) return;
  const total = Math.max(s.total, 1);
  const rows = [
    { label: 'Hot', n: s.hot, cls: 'is-hot' },
    { label: 'Warm', n: s.warm, cls: 'is-warm' },
    { label: 'Cold', n: s.cold, cls: 'is-cold' },
    { label: 'Visit booked', n: s.byStage.SV_BOOKED || 0, cls: '' },
    { label: 'Won', n: s.byStage.WON || 0, cls: '' },
  ];
  $('#funnel').innerHTML = rows.map((r) => `
    <div class="funnel-row ${r.cls}">
      <span>${r.label}</span>
      <span class="funnel-bar"><span class="funnel-fill" style="width:${(r.n / total * 100).toFixed(1)}%"></span></span>
      <span class="funnel-num">${r.n}</span>
    </div>`).join('') +
    `<p class="kpi-sub" style="margin-top:6px">Open pipeline value ${money(s.pipelineValue, true)} across ${s.total} leads.</p>`;
}

$('#leadSearch').addEventListener('input', debounce((e) => {
  state.filters.search = e.target.value.trim();
  loadLeads();
}, 300));

$('#stageFilter').addEventListener('change', (e) => {
  state.filters.stage = e.target.value;
  loadLeads();
});

$('#bandChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  $$('#bandChips .chip').forEach((c) => c.classList.toggle('is-on', c === chip));
  state.filters.band = chip.dataset.band;
  loadLeads();
});

$('#leadTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openLead(tr.dataset.id);
});

$('#newLeadBtn').addEventListener('click', () => {
  const p = $('#leadForm');
  p.hidden = !p.hidden;
});

$('#createLead').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#leadFormNote');
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.consent = fd.get('consent') === 'on';
  body.budget = body.budget ? Number(body.budget) : null;
  note.className = 'form-note';
  note.textContent = 'Saving…';
  try {
    const { lead } = await api('/leads', { method: 'POST', body });
    note.className = 'form-note is-good';
    note.textContent = `Saved. Scored ${lead.score} (${lead.band}) — ${lead.next_action}`;
    e.target.reset();
    loadLeads();
  } catch (err) {
    note.className = 'form-note is-bad';
    note.textContent = err.message;
  }
});

$('#syncMetaBtn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const out = await api('/leads/sync/meta', { method: 'POST', body: {} });
    toast(`Pulled ${out.imported} new lead${out.imported === 1 ? '' : 's'} (${out.duplicates} already here)`);
    loadLeads();
  } catch (err) { toast(err.message, true); }
  e.target.disabled = false;
});

$('#runLadderBtn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const out = await api('/outreach/run', { method: 'POST', body: {} });
    toast(out.sent ? `Sent ${out.sent} follow-up${out.sent === 1 ? '' : 's'}` : 'Nothing due right now');
    loadLeads();
  } catch (err) { toast(err.message, true); }
  e.target.disabled = false;
});

/* ------------------------------------------------------------------ */
/* Lead drawer                                                         */
/* ------------------------------------------------------------------ */

async function openLead(id) {
  const { lead, messages, activity } = await api('/leads/' + id);
  state.openLead = lead;

  $('#drawerBody').innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${esc(lead.full_name)}</h2>
        <p class="drawer-sub">${esc(lead.phone || '')}${lead.email ? ' · ' + esc(lead.email) : ''}</p>
      </div>
      <div style="text-align:right">
        <span class="score-chip ${lead.band === 'HOT' ? 'is-hot' : lead.band === 'WARM' ? 'is-warm' : ''}">${lead.score}</span>
        <p class="drawer-sub">${lead.band}</p>
      </div>
    </div>

    <div class="bot-reply"><strong>Next:</strong> ${esc(lead.next_action)}</div>

    <dl class="detail-rows">
      ${detail('Budget', lead.budget ? money(lead.budget, true) : 'Not captured')}
      ${detail('Area', lead.locality || '—')}
      ${detail('Configuration', lead.property_type || '—')}
      ${detail('Timeline', lead.timeline || 'Not captured')}
      ${detail('Source', (lead.source || '').replace(/_/g, ' '))}
      ${detail('Last touch', ago(lead.last_contact_at))}
    </dl>

    <div class="drawer-section">
      <h3>Why this score</h3>
      <ul class="reasons">${lead.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>

    <div class="drawer-section">
      <h3>Stage</h3>
      <select class="control" id="stageSelect">
        ${STAGES.map((s) => `<option value="${s}" ${s === lead.stage ? 'selected' : ''}>${STAGE_LABEL[s]}</option>`).join('')}
      </select>
    </div>

    <div class="drawer-section">
      <h3>Follow up</h3>
      <div class="action-row" id="channelRow">
        <button class="btn btn-sm" data-ch="whatsapp">WhatsApp</button>
        <button class="btn btn-sm btn-ghost" data-ch="email">Email</button>
        <button class="btn btn-sm btn-ghost" data-ch="sms">SMS</button>
        <button class="btn btn-sm btn-ghost" data-ch="call">Call</button>
        <button class="btn btn-sm btn-ghost" id="ladderBtn">Queue cadence</button>
      </div>
      <div class="draft-box" id="draftBox" style="margin-top:12px"></div>
    </div>

    <div class="drawer-section">
      <h3>Conversation</h3>
      <div class="thread">
        ${messages.length ? messages.map((m) => `
          <div class="bubble ${m.direction}">
            <div class="bubble-meta">${m.direction === 'inbound' ? 'Lead' : 'Us'} · ${esc(m.channel)} · ${ago(m.created_at)}</div>
            ${esc(m.body)}
          </div>`).join('') : '<p class="empty">Nothing yet. Send the first message above.</p>'}
      </div>
    </div>

    <div class="drawer-section">
      <h3>Activity</h3>
      <ul class="reasons">
        ${activity.length ? activity.slice(0, 8).map((a) => `<li>${esc(a.summary)} — ${ago(a.created_at)}</li>`).join('')
          : '<li>No activity logged yet.</li>'}
      </ul>
    </div>

    <div class="action-row">
      <button class="btn btn-sm btn-ghost" id="closeDrawer">Close</button>
    </div>`;

  $('#drawer').hidden = false;
  $('#scrim').hidden = false;

  $('#closeDrawer').addEventListener('click', closeDrawer);
  $('#stageSelect').addEventListener('change', async (e) => {
    try {
      await api('/leads/' + lead.id, { method: 'PATCH', body: { stage: e.target.value } });
      toast('Stage updated');
      loadLeads();
    } catch (err) { toast(err.message, true); }
  });
  $('#ladderBtn').addEventListener('click', async () => {
    try {
      const out = await api('/outreach/ladder/' + lead.id, { method: 'POST', body: {} });
      toast(`${out.queued} follow-ups queued on the ${out.band.toLowerCase()} cadence`);
    } catch (err) { toast(err.message, true); }
  });
  $('#channelRow').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-ch]');
    if (b) showDraft(lead.id, b.dataset.ch);
  });

  showDraft(lead.id, 'whatsapp');
}

function detail(label, value) {
  return `<div class="detail"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}

async function showDraft(leadId, channel) {
  const box = $('#draftBox');
  box.innerHTML = '<p class="dim">Writing a draft…</p>';
  try {
    const d = await api(`/outreach/draft/${leadId}?channel=${channel}`);
    box.innerHTML = `
      ${d.subject && channel === 'email' ? `<input class="control" id="draftSubject" value="${esc(d.subject)}">` : ''}
      <textarea class="control" id="draftBody">${esc(d.body)}</textarea>
      <div class="action-row">
        <button class="btn btn-sm" id="sendBtn">${channel === 'call' ? 'Place call' : 'Send ' + channel}</button>
        <span class="dim" style="font-size:13px">${channel === 'call' ? 'Dials the lead, then bridges to your agent line.' : 'Edit anything before it goes out.'}</span>
      </div>`;
    $('#sendBtn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const out = await api('/outreach/send', {
          method: 'POST',
          body: {
            leadId, channel,
            subject: $('#draftSubject')?.value,
            body: $('#draftBody').value,
          },
        });
        toast(out.simulated ? `Simulated ${channel} — add credentials to send for real` : `Sent on ${channel}`);
        loadLeads();
        openLead(leadId);
      } catch (err) {
        toast(err.message, true);
        e.target.disabled = false;
      }
    });
  } catch (err) {
    box.innerHTML = `<p class="form-note is-bad">${esc(err.message)}</p>`;
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  state.openLead = null;
}
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

/* ------------------------------------------------------------------ */
/* Bot console                                                         */
/* ------------------------------------------------------------------ */

$('#botSamples').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) { $('#botInput').value = chip.textContent; $('#botSend').click(); }
});

$('#botSend').addEventListener('click', async () => {
  const text = $('#botInput').value.trim();
  if (!text) return;
  const leadId = $('#botLead').value;
  const out = $('#botOut');
  out.innerHTML = '<p class="dim">Thinking…</p>';
  try {
    const r = await api('/chat/reply', { method: 'POST', body: { leadId: leadId || undefined, text } });
    const extracted = Object.entries(r.extracted || {});
    out.innerHTML = `
      <div class="bot-reply">${r.reply ? esc(r.reply) : 'No reply sent — the lead asked to stop, so they are now marked do-not-contact.'}</div>
      <div class="bot-meta">
        <span class="tag">intent: ${esc(r.intent)}</span>
        <span class="tag">score: ${r.score}</span>
        <span class="badge badge-${String(r.band).toLowerCase()}">${r.band}</span>
      </div>
      <div>
        <h3>Fields pulled out</h3>
        ${extracted.length
          ? `<div class="bot-meta" style="margin-top:6px">${extracted.map(([k, v]) => `<span class="tag">${esc(k)}: ${esc(v)}</span>`).join('')}</div>`
          : '<p class="dim" style="font-size:13.5px">Nothing new in this message.</p>'}
      </div>
      <div>
        <h3>Why</h3>
        <ul class="reasons">${(r.reasons || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      </div>
      <div class="bot-reply" style="background:var(--paper-dim)"><strong>Next:</strong> ${esc(r.next_action)}</div>`;
    if (leadId) loadLeads();
  } catch (err) {
    out.innerHTML = `<p class="form-note is-bad">${esc(err.message)}</p>`;
  }
});

function fillBotLeads() {
  $('#botLead').innerHTML = '<option value="">Test without saving to a lead</option>' +
    state.leads.slice(0, 40).map((l) => `<option value="${esc(l.id)}">${esc(l.full_name)} — ${l.band}</option>`).join('');
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

$('#rangeSelect').addEventListener('change', () => loadOverview().catch((e) => toast(e.message, true)));
$('#refreshBtn').addEventListener('click', () => boot());

async function boot() {
  try {
    await loadHealth();
    await loadLeads();
    await loadOverview();
    fillBotLeads();
  } catch (e) {
    toast(e.message, true);
  }
}

boot();