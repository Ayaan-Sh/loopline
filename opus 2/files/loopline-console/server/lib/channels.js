'use strict';

/**
 * Outreach channels. Each function returns the same shape:
 *   { ok, channel, to, id, simulated, detail }
 *
 * When credentials are missing the send is *simulated* rather than thrown, so
 * the whole flow — button, activity log, score refresh — can be demonstrated
 * end to end before a client provides SMTP or Twilio keys.
 */

const config = require('../config');

let mailer = null;
let twilioClient = null;

function getMailer() {
  if (mailer || config.demo.email) return mailer;
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass },
  });
  return mailer;
}

function getTwilio() {
  if (twilioClient || config.demo.telephony) return twilioClient;
  const twilio = require('twilio');
  twilioClient = twilio(config.twilio.sid, config.twilio.token);
  return twilioClient;
}

/** Quiet hours guard — TRAI-friendly and just good manners. */
function withinQuietHours(now = new Date()) {
  const [start, end] = (config.business.quietHours || '21:00-09:00').split('-');
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMin(start), e = toMin(end);
  return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
}

async function sendEmail({ to, subject, body, html }) {
  if (!to) return { ok: false, channel: 'email', detail: 'No email address on this lead' };
  if (config.demo.email) {
    return { ok: true, channel: 'email', to, simulated: true, id: 'sim_' + Date.now(), detail: 'Simulated — add SMTP settings to send for real' };
  }
  const info = await getMailer().sendMail({
    from: config.email.from,
    to,
    subject,
    text: body,
    html: html || `<div style="font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#12121A">${escapeHtml(body).replace(/\n/g, '<br>')}</div>`,
    replyTo: config.business.replyTo || undefined,
  });
  return { ok: true, channel: 'email', to, id: info.messageId };
}

async function sendSms({ to, body }) {
  if (!to) return { ok: false, channel: 'sms', detail: 'No phone number on this lead' };
  if (config.demo.telephony) {
    return { ok: true, channel: 'sms', to, simulated: true, id: 'sim_' + Date.now(), detail: 'Simulated — add Twilio credentials to send for real' };
  }
  const msg = await getTwilio().messages.create({ to, from: config.twilio.fromSms, body });
  return { ok: true, channel: 'sms', to, id: msg.sid };
}

async function sendWhatsapp({ to, body }) {
  if (!to) return { ok: false, channel: 'whatsapp', detail: 'No phone number on this lead' };
  if (config.demo.telephony) {
    return { ok: true, channel: 'whatsapp', to, simulated: true, id: 'sim_' + Date.now(), detail: 'Simulated — add Twilio credentials to send for real' };
  }
  const msg = await getTwilio().messages.create({
    to: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    from: config.twilio.fromWhatsapp,
    body,
  });
  return { ok: true, channel: 'whatsapp', to, id: msg.sid };
}

/**
 * Place a call. Two modes:
 *  - connect: dials the lead, then bridges to the agent's number.
 *  - speak: plays a short message (useful for confirmations and reminders).
 */
async function placeCall({ to, mode = 'connect', agentNumber, say }) {
  if (!to) return { ok: false, channel: 'call', detail: 'No phone number on this lead' };
  if (config.demo.telephony) {
    return { ok: true, channel: 'call', to, simulated: true, id: 'sim_' + Date.now(), detail: 'Simulated — add Twilio credentials to dial for real' };
  }
  const twiml = mode === 'speak'
    ? `<Response><Say voice="Polly.Aditi">${escapeXml(say || 'Hello, this is a call from our sales team.')}</Say></Response>`
    : `<Response><Say voice="Polly.Aditi">Connecting you to our sales team, please hold.</Say><Dial>${escapeXml(agentNumber || config.twilio.fromVoice)}</Dial></Response>`;

  const call = await getTwilio().calls.create({
    to,
    from: config.twilio.fromVoice,
    twiml,
  });
  return { ok: true, channel: 'call', to, id: call.sid };
}

async function send(channel, payload) {
  switch (channel) {
    case 'email': return sendEmail(payload);
    case 'sms': return sendSms(payload);
    case 'whatsapp': return sendWhatsapp(payload);
    case 'call': return placeCall(payload);
    default: return { ok: false, channel, detail: `Unknown channel: ${channel}` };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

module.exports = { send, sendEmail, sendSms, sendWhatsapp, placeCall, withinQuietHours };
