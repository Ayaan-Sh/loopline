# ========== ads_data.py ==========
# Real Meta Marketing API + Google Ads API integration for the Loopline
# dashboard's "Ad performance" panel (GET /ads/overview in chatbot.py).
#
# This is the ONLY file that needs to change to go live with real ad
# accounts — chatbot.py just imports build_ads_overview() and blends it
# with your real qualification numbers from the database.
#
# If credentials for a platform are missing, that platform is silently
# skipped (not faked) so you can go live with just one platform first.
# If BOTH are missing, build_ads_overview() raises AdsDataUnavailable and
# chatbot.py falls back to letting the frontend show its own local mock
# data instead of pretending to have live numbers.
#
# Install:
#   pip install facebook-business google-ads
#
# ---------------------------------------------------------------------
# .env additions — Meta Marketing API
# ---------------------------------------------------------------------
# META_ACCESS_TOKEN=       # long-lived access token with ads_read permission
# META_AD_ACCOUNT_ID=      # numeric account id, WITHOUT the "act_" prefix
# META_APP_ID=             # optional, only needed if you enable App Secret Proof
# META_APP_SECRET=         # optional, pair with META_APP_ID above
#
# ---------------------------------------------------------------------
# .env additions — Google Ads API
# ---------------------------------------------------------------------
# GOOGLE_ADS_DEVELOPER_TOKEN=
# GOOGLE_ADS_CLIENT_ID=
# GOOGLE_ADS_CLIENT_SECRET=
# GOOGLE_ADS_REFRESH_TOKEN=
# GOOGLE_ADS_LOGIN_CUSTOMER_ID=   # your manager (MCC) account id, digits only, no dashes
# GOOGLE_ADS_CUSTOMER_ID=         # the actual ad account id being reported on, digits only
# ---------------------------------------------------------------------

import os
from dotenv import load_dotenv

load_dotenv()

META_ACCESS_TOKEN = os.getenv("META_ACCESS_TOKEN")
META_AD_ACCOUNT_ID = os.getenv("META_AD_ACCOUNT_ID")
META_APP_ID = os.getenv("META_APP_ID")
META_APP_SECRET = os.getenv("META_APP_SECRET")

GOOGLE_ADS_DEVELOPER_TOKEN = os.getenv("GOOGLE_ADS_DEVELOPER_TOKEN")
GOOGLE_ADS_CLIENT_ID = os.getenv("GOOGLE_ADS_CLIENT_ID")
GOOGLE_ADS_CLIENT_SECRET = os.getenv("GOOGLE_ADS_CLIENT_SECRET")
GOOGLE_ADS_REFRESH_TOKEN = os.getenv("GOOGLE_ADS_REFRESH_TOKEN")
GOOGLE_ADS_LOGIN_CUSTOMER_ID = os.getenv("GOOGLE_ADS_LOGIN_CUSTOMER_ID")
GOOGLE_ADS_CUSTOMER_ID = os.getenv("GOOGLE_ADS_CUSTOMER_ID")

# Lead-like conversion action types we count as "a lead" in Meta's
# `actions` array. Meta doesn't have one universal "lead" field — it's
# buried in per-action-type breakdowns, and which ones apply depends on
# how your campaigns are set up (native Lead Ads vs a website form
# pixel/CAPI event). Adjust this list to match your actual setup.
META_LEAD_ACTION_TYPES = {
    "lead",
    "onsite_conversion.lead_grouped",
    "offsite_conversion.fb_pixel_lead",
    "onsite_web_lead",
}


class AdsDataUnavailable(Exception):
    """Raised when neither platform has credentials configured, so the
    caller (chatbot.py) knows to fall back to mock/no data rather than
    silently returning zeros."""
    pass


# ============ Meta Marketing API ============
def _meta_configured():
    return bool(META_ACCESS_TOKEN and META_AD_ACCOUNT_ID)


def fetch_meta_campaigns(date_preset="last_30d"):
    """Returns a list of campaign dicts (platform='meta') with spend,
    leads, ctr, cpc, cpl for the given date window. Returns [] if Meta
    credentials aren't configured, rather than raising — a missing
    platform shouldn't take down the whole dashboard."""
    if not _meta_configured():
        return []

    from facebook_business.api import FacebookAdsApi
    from facebook_business.adobjects.adaccount import AdAccount
    from facebook_business.adobjects.adsinsights import AdsInsights

    if META_APP_ID and META_APP_SECRET:
        FacebookAdsApi.init(META_APP_ID, META_APP_SECRET, META_ACCESS_TOKEN)
    else:
        FacebookAdsApi.init(access_token=META_ACCESS_TOKEN)

    account = AdAccount(f"act_{META_AD_ACCOUNT_ID}")
    fields = [
        AdsInsights.Field.campaign_id,
        AdsInsights.Field.campaign_name,
        AdsInsights.Field.spend,
        AdsInsights.Field.clicks,
        AdsInsights.Field.impressions,
        AdsInsights.Field.ctr,
        AdsInsights.Field.cpc,
        AdsInsights.Field.actions,
    ]
    params = {"level": "campaign", "date_preset": date_preset}
    insights = account.get_insights(fields=fields, params=params)

    campaigns = []
    for row in insights:
        spend = float(row.get("spend", 0) or 0)
        clicks = int(row.get("clicks", 0) or 0)
        ctr = float(row.get("ctr", 0) or 0)
        cpc = float(row.get("cpc", 0) or 0)

        leads = 0
        for action in row.get("actions", []) or []:
            if action.get("action_type") in META_LEAD_ACTION_TYPES:
                leads += int(float(action.get("value", 0) or 0))

        cpl = round(spend / leads, 2) if leads else None
        campaigns.append({
            "id": f"meta_{row.get('campaign_id')}",
            "platform": "meta",
            "name": row.get("campaign_name", "Untitled campaign"),
            "status": "Active",
            "spend": round(spend, 2),
            "leads": leads,
            "ctr": round(ctr, 2),
            "cpc": round(cpc, 2),
            "cpl": cpl,
        })
    return campaigns


# ============ Google Ads API ============
def _google_ads_configured():
    return bool(
        GOOGLE_ADS_DEVELOPER_TOKEN and GOOGLE_ADS_CLIENT_ID and
        GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_REFRESH_TOKEN and
        GOOGLE_ADS_CUSTOMER_ID
    )


def fetch_google_campaigns():
    """Returns a list of campaign dicts (platform='google') for the last
    30 days. Uses `conversions` as the lead proxy — if your account tracks
    leads as a specific conversion action rather than "all conversions",
    swap the GAQL metric below to metrics.conversions_by_conversion_date
    filtered to that action, or add a WHERE on segments.conversion_action_name."""
    if not _google_ads_configured():
        return []

    from google.ads.googleads.client import GoogleAdsClient

    config = {
        "developer_token": GOOGLE_ADS_DEVELOPER_TOKEN,
        "client_id": GOOGLE_ADS_CLIENT_ID,
        "client_secret": GOOGLE_ADS_CLIENT_SECRET,
        "refresh_token": GOOGLE_ADS_REFRESH_TOKEN,
        "use_proto_plus": True,
    }
    if GOOGLE_ADS_LOGIN_CUSTOMER_ID:
        config["login_customer_id"] = GOOGLE_ADS_LOGIN_CUSTOMER_ID

    client = GoogleAdsClient.load_from_dict(config)
    ga_service = client.get_service("GoogleAdsService")

    query = """
        SELECT
          campaign.id,
          campaign.name,
          campaign.status,
          metrics.cost_micros,
          metrics.clicks,
          metrics.impressions,
          metrics.ctr,
          metrics.average_cpc,
          metrics.conversions
        FROM campaign
        WHERE segments.date DURING LAST_30_DAYS
          AND campaign.status != 'REMOVED'
    """

    campaigns = []
    response = ga_service.search_stream(customer_id=GOOGLE_ADS_CUSTOMER_ID, query=query)
    for batch in response:
        for row in batch.results:
            spend = row.metrics.cost_micros / 1_000_000
            leads = round(row.metrics.conversions)
            cpc = row.metrics.average_cpc / 1_000_000
            ctr = row.metrics.ctr * 100
            cpl = round(spend / leads, 2) if leads else None
            campaigns.append({
                "id": f"google_{row.campaign.id}",
                "platform": "google",
                "name": row.campaign.name,
                "status": row.campaign.status.name.title(),
                "spend": round(spend, 2),
                "leads": leads,
                "ctr": round(ctr, 2),
                "cpc": round(cpc, 2),
                "cpl": cpl,
            })
    return campaigns


# ============ Blend with Loopline's real qualification data ============
def build_ads_overview(real_total_leads, real_qualified_leads):
    """Combines live Meta + Google campaign data with Loopline's OWN real
    lead/qualification numbers (from the database, not the ad platforms —
    Meta and Google have no idea whether a lead actually qualified).

    real_total_leads / real_qualified_leads come from get_all_leads() in
    chatbot.py. Per-campaign "est. qualified" is a blended estimate (each
    campaign's leads x the account-wide qualification rate) since ad
    platforms don't know which of their leads converted downstream unless
    you've wired up server-side conversion tracking (Conversions API /
    Enhanced Conversions) — that's the next step once volume justifies it."""
    if not _meta_configured() and not _google_ads_configured():
        raise AdsDataUnavailable("Neither Meta nor Google Ads credentials are configured")

    meta_campaigns = fetch_meta_campaigns()
    google_campaigns = fetch_google_campaigns()
    campaigns = meta_campaigns + google_campaigns

    total_spend = round(sum(c["spend"] for c in campaigns), 2)
    total_ad_leads = sum(c["leads"] for c in campaigns)
    cost_per_lead = round(total_spend / total_ad_leads, 2) if total_ad_leads else 0

    real_qualification_rate = (
        round((real_qualified_leads / real_total_leads) * 100, 1) if real_total_leads else 0.0
    )
    cost_per_qualified_lead = (
        round(total_spend / real_qualified_leads, 2) if real_qualified_leads else None
    )

    qual_rate_fraction = real_qualification_rate / 100
    for c in campaigns:
        est_qualified = round(c["leads"] * qual_rate_fraction, 1)
        c["est_qualified_leads"] = est_qualified
        c["est_cpql"] = round(c["spend"] / est_qualified, 2) if est_qualified else None

    return {
        "total_spend": total_spend,
        "total_ad_leads": total_ad_leads,
        "real_total_leads": real_total_leads,
        "real_qualified_leads": real_qualified_leads,
        "real_qualification_rate": real_qualification_rate,
        "cost_per_lead": cost_per_lead,
        "cost_per_qualified_lead": cost_per_qualified_lead,
        "campaigns": campaigns,
    }
