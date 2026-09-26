'use strict';

require('dotenv').config();

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || v === '1';
}

const config = {
  port: Number(process.env.PORT || 4000),
  appName: process.env.APP_NAME || 'Loopline Console',

  // Anything the console needs to be treated as an admin action.
  adminKey: process.env.ADMIN_KEY || '',

  meta: {
    accessToken: process.env.META_ACCESS_TOKEN || '',
    adAccountId: normalizeAccount(process.env.META_AD_ACCOUNT_ID || ''),
    pageId: process.env.META_PAGE_ID || '',
    apiVersion: process.env.META_API_VERSION || 'v21.0',
    verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN || 'loopline-verify',
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  email: {
    from: process.env.MAIL_FROM || '',
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    secure: bool(process.env.SMTP_SECURE, false),
  },

  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || '',
    token: process.env.TWILIO_AUTH_TOKEN || '',
    fromSms: process.env.TWILIO_SMS_FROM || '',
    fromWhatsapp: process.env.TWILIO_WHATSAPP_FROM || '',
    fromVoice: process.env.TWILIO_VOICE_FROM || '',
  },

  // The bot runs on rules by default. Point this at any OpenAI-compatible
  // endpoint (Ollama, vLLM, LM Studio, OpenRouter) to get generated replies.
  llm: {
    baseUrl: process.env.LLM_BASE_URL || '',
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'qwen2.5:3b',
  },

  business: {
    name: process.env.BUSINESS_NAME || 'Loopline Realty',
    agentName: process.env.AGENT_NAME || 'Riya',
    city: process.env.BUSINESS_CITY || 'Pune',
    // Used by the scoring formula to judge whether a stated budget is workable.
    minBudget: Number(process.env.MIN_BUDGET || 4500000),
    replyTo: process.env.REPLY_TO || process.env.MAIL_FROM || '',
    quietHours: process.env.QUIET_HOURS || '21:00-09:00',
  },
};

config.demo = {
  meta: !config.meta.accessToken || !config.meta.adAccountId,
  db: !config.supabase.url || !config.supabase.serviceKey,
  email: !config.email.host || !config.email.user,
  telephony: !config.twilio.sid || !config.twilio.token,
};

function normalizeAccount(id) {
  if (!id) return '';
  return id.startsWith('act_') ? id : 'act_' + id;
}

module.exports = config;
