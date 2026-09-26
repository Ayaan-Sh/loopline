# Loopline Console

Meta Ads tracking, a scored lead pipeline, and a built-in qualification bot — in one app a client can run on their own server.

Two things happen here. Money goes out through Meta ads, and leads come back in. The console shows both in the same place, so the question stops being "what was our CTR" and becomes "what did we pay for a lead who actually booked a site visit".

There is no external chatbot service. The bot that qualifies leads, extracts their budget and timeline, scores them hot/warm/cold, and runs the follow-up cadence ships inside this repo.

---

## Run it right now

```bash
npm install
cp .env.example .env     # optional — it runs without this
npm start                # http://localhost:4000
```

It starts with no keys at all. Meta metrics, campaigns, and five sample leads are generated locally so the whole product is clickable in a demo before anyone hands over credentials. Sends are simulated and logged rather than dropped, so the follow-up flow demos end to end too.

Verify everything works:

```bash
npm run check    # 44 checks across ads, leads, bot, scoring, and outreach
```

---

## Turning on the real thing

Four connections, each independent. Connect them in any order — whatever is missing stays in sample mode instead of breaking.

### 1. Database (Supabase)

1. Create a project at supabase.com.
2. SQL editor → paste `supabase/schema.sql` → run.
3. Project settings → API → copy the URL and the **service_role** key.

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Until this is set, leads live in memory and disappear on restart.

### 2. Meta Ads

1. business.facebook.com → Business settings → Users → **System users** → add one, give it Admin access.
2. Assign the ad account (full control) and the Facebook page.
3. Generate a token with: `ads_read`, `ads_management`, `leads_retrieval`, `pages_show_list`, `pages_manage_metadata`, `business_management`.
4. Copy the ad account ID from Ads Manager — it looks like `act_1234567890`.

```env
META_ACCESS_TOKEN=EAAG...
META_AD_ACCOUNT_ID=act_1234567890
META_PAGE_ID=1029384756
```

Open **Setup** in the console to confirm the connection. Live errors from Meta come back with a plain-language hint instead of a code.

### 3. Lead ads arriving instantly

In the Meta app dashboard, subscribe the page to the `leadgen` webhook:

- Callback URL: `https://your-domain.com/api/chat/webhook/meta`
- Verify token: whatever you set as `META_WEBHOOK_VERIFY_TOKEN`

Now form submissions appear in the console within seconds, already scored, with the follow-up cadence queued. The **Pull from Meta** button does the same thing manually for the last seven days if the webhook is not set up yet.

### 4. Replies, calls, and email

Point your Twilio number's messaging webhook at `https://your-domain.com/api/chat/webhook/twilio`. Inbound WhatsApp or SMS goes to the bot, which replies, fills in missing fields, re-scores the lead, and re-paces the cadence.

```env
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_SMS_FROM=+1...
TWILIO_VOICE_FROM=+1...

SMTP_HOST=smtp.yourprovider.com
SMTP_USER=riya@yourdomain.com
SMTP_PASS=...
MAIL_FROM="Riya from Loopline Realty <riya@yourdomain.com>"
```

---

## What is in the box

| Screen | What it does |
|---|---|
| **Overview** | Spend, leads, reach, CTR, cost per lead, and cost per *qualified* lead. Daily spend line with leads as bars. Live pipeline counts. |
| **Ads** | Every campaign with status and budget. Pause, resume, change budget. Create a campaign, ad set, creative, and ad in one form — always created paused. |
| **Leads** | Scored list, hottest first. Filter by temperature, stage, or search. Add leads by hand, import a list, or pull from Meta. |
| **Lead drawer** | Why the score is what it is, the full conversation, stage control, and four follow-up buttons: WhatsApp, Email, SMS, Call. Each one writes a draft you can edit before it goes. |
| **Bot** | Paste what a lead might say, see the reply, the fields extracted, and the score it produces. This is the screen that sells the product. |
| **Setup** | Which integrations are live and exactly what to do about the ones that are not. |

### Follow-up actions

Clicking **Follow up** gives a draft written for that lead's temperature — a hot lead gets a site-visit slot offered, a cold lead gets one re-engagement line with an opt-out. Calls dial the lead and bridge to your agent's number. Nothing sends during quiet hours (`21:00-09:00` by default).

---

## The scoring formula

In `server/lib/scoring.js`. No model, no black box — six weighted signals minus penalties, clamped to 100. Every lead carries the reasons behind its number.

| Signal | Max | What moves it |
|---|---|---|
| Budget fit | 25 | Stated budget against `MIN_BUDGET`, the cheapest unit you can actually sell |
| Timeline | 20 | Within 30 days scores near full, over six months scores near zero |
| Intent | 20 | Phrases in their own messages: site visit, loan approved, booking, price, call me |
| Engagement | 15 | Number of replies, length, and how recently they answered |
| Completeness | 10 | How many of name, phone, budget, area, configuration are filled |
| Source | 10 | Referral > website > Meta lead ad > cold list |
| Penalties | — | Opt-out (−45), bought elsewhere (−35), silence decay (−1/day after 3), no consent, four attempts with no reply |

**HOT ≥ 70** · **WARM 45–69** · **COLD < 45**

An explicit opt-out forces COLD regardless of the arithmetic, marks the lead do-not-contact, and cancels every queued follow-up.

Change `MIN_BUDGET` per client — it is the single number that most affects scoring accuracy. After changing weights, hit `POST /api/leads/rescore` to re-run the whole pipeline.

## The bot

In `server/lib/bot.js`. Rules first: intent detection, slot filling for five fields, and one next question chosen from what is still missing. It handles Indian budget phrasing (`95 lakh`, `1.2 cr`, `95L`) and Pune localities out of the box.

Set `LLM_BASE_URL` to any OpenAI-compatible endpoint — Ollama on the same box, vLLM, LM Studio, OpenRouter — and it rephrases the reply so it reads human. The rules still decide *what* gets said; the model only decides *how*. If the model times out or errors, the rule reply goes out and the conversation continues. That fallback is why this does not need an external chatbot webhook to stay up.

The cadence adapts: a hot lead gets four steps at half-day spacing, warm gets seven over fifteen days, cold gets three spread wide. `POST /api/outreach/run` processes whatever is due — put it on a cron every 15 minutes.

---

## API

```
GET    /api/health                      integration status
GET    /api/meta/overview?range=last_30d spend + leads + pipeline, one call
GET    /api/meta/campaigns              list campaigns
POST   /api/meta/campaigns              create campaign → ad set → creative → ad (paused)
POST   /api/meta/campaigns/:id/status   ACTIVE | PAUSED | ARCHIVED
POST   /api/meta/campaigns/:id/budget   change daily budget
GET    /api/leads                       scored list + summary
GET    /api/leads/:id                   lead + conversation + activity
POST   /api/leads                       create
PATCH  /api/leads/:id                   update (stage, fields)
POST   /api/leads/import                bulk import rows
POST   /api/leads/sync/meta             pull lead-ad submissions
POST   /api/leads/rescore               re-run the formula over everything
POST   /api/chat/reply                  bot turn against a lead
POST   /api/chat/analyse                score a message without saving
GET    /api/outreach/draft/:leadId      draft for a channel
POST   /api/outreach/send               send email / sms / whatsapp / call
POST   /api/outreach/ladder/:leadId     queue the cadence
POST   /api/outreach/run                process everything due
```

Set `ADMIN_KEY` in `.env` to require an `x-admin-key` header on every `/api` call. Webhooks are exempt — they carry their own verification.

---

## Deploying

Any Node host works. Render or Railway: connect the repo, build `npm install`, start `npm start`, paste the env vars, done. On a VPS use pm2 or a systemd unit behind nginx with TLS — Meta and Twilio both require HTTPS webhooks.

Add one cron job:

```
*/15 * * * * curl -s -X POST https://your-domain.com/api/outreach/run -H "x-admin-key: $ADMIN_KEY"
```

For local webhook testing, `ngrok http 4000` and paste the https URL into Meta and Twilio.

---

## Selling and handing this over

**The demo that works:** open it with no keys. Walk through Overview, then the Bot screen — paste "Budget around 95 lakh, loan approved, can I visit Saturday?" and let them watch it extract the budget, score it 80-something, and write the reply. Then open a hot lead and show the four follow-up buttons. That sequence is the product.

**Handover checklist**

- [ ] Client creates their own Supabase project and runs `schema.sql`
- [ ] Client generates their own Meta system user token (never reuse yours)
- [ ] Set `MIN_BUDGET`, `BUSINESS_NAME`, `AGENT_NAME`, `BUSINESS_CITY` for their inventory
- [ ] Set `ADMIN_KEY` before it is publicly reachable
- [ ] Meta `leadgen` webhook subscribed and verified
- [ ] Twilio messaging webhook pointed at the console
- [ ] Cron job for `/api/outreach/run`
- [ ] Run `npm run check` on their server and show them the 44 passing checks
- [ ] Edit the message templates in `server/routes/outreach.js` to their voice
- [ ] Add their localities to `CITY_HINTS` in `server/lib/bot.js`

**Things to tell the buyer honestly, before they find out**

- `leads_retrieval` needs Meta App Review before it works on a live app. Development mode works for testing with the admins of the app.
- WhatsApp business messaging outside a 24-hour reply window needs pre-approved templates. Inside the window the bot replies freely.
- Indian SMS needs DLT registration of sender ID and templates. WhatsApp and email have no such requirement.
- Special ad category is set to `HOUSING` on created campaigns, which Meta requires for real estate and which limits targeting by age, gender, and postcode. That is Meta's rule, not a product limitation.
- The console has no user login of its own. Put it behind `ADMIN_KEY` plus your host's auth, or a VPN, before it faces the internet.

**A reasonable commercial shape:** setup fee for installation and configuration, then a monthly licence per ad account. The client pays Meta, Twilio, and Supabase directly — keep those out of your invoice so your margin is not tied to their ad spend.

---

## File map

```
server/
  index.js              express app, static hosting, admin key gate
  config.js             every setting, plus sample-mode detection
  lib/meta.js           Meta Marketing API + sample data generator
  lib/store.js          Supabase, with an in-memory twin for demos
  lib/scoring.js        the hot/warm/cold formula
  lib/bot.js            intent, slot filling, replies, cadence
  lib/channels.js       email, sms, whatsapp, voice
  routes/               meta, leads, outreach, chat + webhooks
  selftest.js           npm run check
public/                 the dashboard (no build step, no framework)
supabase/schema.sql     tables, indexes, RLS, reporting view
```

No build step anywhere. Edit a file, restart, refresh.
