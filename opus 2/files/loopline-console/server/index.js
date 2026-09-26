'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const store = require('./lib/store');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true })); // Twilio posts form-encoded

/** Optional shared-secret gate. Set ADMIN_KEY to lock the API down. */
app.use('/api', (req, res, next) => {
  if (!config.adminKey) return next();
  if (req.path.startsWith('/chat/webhook')) return next(); // webhooks carry their own verification
  const key = req.get('x-admin-key') || req.query.key;
  if (key === config.adminKey) return next();
  res.status(401).json({ error: 'Missing or invalid admin key' });
});

app.use('/api/meta', require('./routes/meta'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/outreach', require('./routes/outreach'));
app.use('/api/chat', require('./routes/chat'));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: config.appName,
    storage: store.mode,
    business: {
      name: config.business.name,
      agent: config.business.agentName,
      city: config.business.city,
      currencyMin: config.business.minBudget,
      quietHours: config.business.quietHours,
    },
    integrations: {
      metaAds: config.demo.meta ? 'sample data' : 'live',
      database: config.demo.db ? 'in-memory' : 'supabase',
      email: config.demo.email ? 'simulated' : 'smtp',
      telephony: config.demo.telephony ? 'simulated' : 'twilio',
      bot: config.llm.baseUrl ? `rules + ${config.llm.model}` : 'rules only',
    },
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api', (req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Something went wrong',
    hint: err.hint || undefined,
    metaCode: err.metaCode || undefined,
  });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`\n  ${config.appName}  →  http://localhost:${config.port}`);
    console.log(`  storage: ${store.mode}   meta: ${config.demo.meta ? 'sample data' : 'live'}   bot: ${config.llm.baseUrl ? 'rules + model' : 'rules only'}\n`);
  });
}

module.exports = app;
