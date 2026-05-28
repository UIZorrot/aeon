const DEFAULT_MIN_DEFI_APY_PCT = 3;
const DEFAULT_MIN_DEFI_TVL_USD = 1_000_000;
const DEFAULT_STABLECOIN_IDS = new Set([
  "usdc",
  "usdt",
  "usde",
  "usds",
  "dai",
  "pyusd",
  "usd1",
  "rlusd",
  "crvusd",
  "gho",
  "usdg",
  "usdd",
  "susde"
]);

export function buildStablecoinDefiOpportunities({ poolsPayloads = [], campaignsPayload = null } = {}, filters = {}) {
  const maxResults = Math.min(Math.max(Math.round(numberOr(filters.maxResults, 25)), 1), 100);
  return [
    ...extractStablecoinDefiPools(poolsPayloads, filters),
    ...extractStablecoinDefiCampaigns(campaignsPayload, filters)
  ]
    .sort((a, b) => Number(b.scoreBps || 0) - Number(a.scoreBps || 0))
    .slice(0, maxResults);
}

export function extractStablecoinDefiPools(payloads, filters = {}) {
  const rows = flattenPoolRows(payloads);
  const chains = allowlist(filters.chains);
  const assets = stablecoinAllowlist(filters);
  const minApyPct = numberOr(filters.minDefiApyPct, DEFAULT_MIN_DEFI_APY_PCT);
  const minTvlUsd = numberOr(filters.minDefiTvlUsd ?? filters.minTvlUsd, DEFAULT_MIN_DEFI_TVL_USD);
  const opportunities = [];

  for (const row of rows) {
    if (String(row?.source || "").toLowerCase() !== "defi") continue;
    if (row.is_available === 0 || row.is_available === false) continue;

    const assetSymbol = String(row.asset_symbol || "").toUpperCase();
    const assetMasterUid = String(row.asset_master_uid || "").toLowerCase();
    const chainUid = String(row.chain_uid || "").toLowerCase();
    if (!assetSymbol) continue;
    if (!isAllowedStablecoin(assetMasterUid, assetSymbol, assets)) continue;
    if (chains.size && !chains.has(chainUid)) continue;

    const apyPct = fractionToPct(row.supply_apy_total);
    const tvlUsd = numberOr(row.supply_tvl, 0);
    if (!Number.isFinite(apyPct) || apyPct < minApyPct) continue;
    if (tvlUsd < minTvlUsd) continue;

    const apyBps = apyPct * 100;
    opportunities.push({
      kind: "stablecoin_defi_yield",
      source: "barker",
      poolUid: row.pool_uid || null,
      poolName: row.pool_name || null,
      protocolUid: row.protocol_uid || null,
      protocolName: row.protocol_name || null,
      protocolUrl: row.protocol_url || null,
      chainUid: chainUid || null,
      chainName: row.chain_name || null,
      assetUid: row.asset_uid || null,
      assetMasterUid: assetMasterUid || null,
      assetSymbol,
      apyPct: round(apyPct, 6),
      apyBps: round(apyBps, 4),
      baseApyPct: round(fractionToPct(row.supply_apy_base), 6),
      rewardApyPct: round(fractionToPct(row.supply_apy_reward), 6),
      tvlUsd,
      isComposable: Boolean(row.is_composable),
      executionStatus: row.execution?.status || null,
      apySemantics: row.apy_semantics || null,
      scoreBps: round(apyBps, 4)
    });
  }

  return dedupeByKey(opportunities, (item) => ["pool", item.poolUid, item.assetSymbol, item.chainUid].join("|"));
}

export function extractStablecoinDefiCampaigns(payload, filters = {}) {
  const campaigns = Array.isArray(payload?.data?.campaigns) ? payload.data.campaigns : [];
  const chains = allowlist(filters.chains);
  const assets = stablecoinAllowlist(filters);
  const minApyPct = numberOr(filters.minDefiApyPct, DEFAULT_MIN_DEFI_APY_PCT);
  const minTvlUsd = numberOr(filters.minDefiTvlUsd ?? filters.minTvlUsd, DEFAULT_MIN_DEFI_TVL_USD);
  const maxLockDays = numberOr(filters.maxDefiLockDays, Number.POSITIVE_INFINITY);
  const opportunities = [];

  for (const campaign of campaigns) {
    if (Number(campaign?.is_cex || 0) !== 0) continue;
    if (campaign.is_active === 0 || campaign.is_active === false) continue;
    if (campaign.pool_status && String(campaign.pool_status).toLowerCase() !== "active") continue;

    const assetSymbol = String(campaign.asset_symbol || "").toUpperCase();
    const assetMasterUid = String(campaign.asset_master_uid || "").toLowerCase();
    const chainUid = String(campaign.chain_uid || "").toLowerCase();
    if (!assetSymbol) continue;
    if (!isAllowedStablecoin(assetMasterUid, assetSymbol, assets)) continue;
    if (chains.size && !chains.has(chainUid)) continue;

    const apyPct = fractionToPct(campaign.campaign_apy);
    const tvlUsd = numberOr(campaign.tvl_usd, 0);
    const lockDays = numberOr(campaign.lock_days, 0);
    if (!Number.isFinite(apyPct) || apyPct < minApyPct) continue;
    if (tvlUsd && tvlUsd < minTvlUsd) continue;
    if (lockDays > maxLockDays) continue;

    const scoreBps = apyPct * 100;
    opportunities.push({
      kind: "stablecoin_defi_campaign",
      source: "barker",
      campaignName: campaign.campaign_name || null,
      protocolUid: campaign.protocol_uid || null,
      poolUid: campaign.pool_uid || null,
      chainUid: chainUid || null,
      assetMasterUid: assetMasterUid || null,
      assetSymbol,
      apyPct: round(apyPct, 6),
      apyBps: round(scoreBps, 4),
      baseApyPct: round(fractionToPct(campaign.base_apy), 6),
      rewardApyPct: round(fractionToPct(campaign.reward_apy), 6),
      lockDays,
      minAmount: nullableNumber(campaign.min_amount),
      maxAmount: nullableNumber(campaign.max_amount),
      serviceFeePct: nullableNumber(campaign.service_fee_pct),
      tvlUsd,
      announcementUrl: campaign.announcement_url || null,
      tutorialUrl: campaign.tutorial_url || null,
      startDate: campaign.start_date || null,
      endDate: campaign.end_date || null,
      notes: campaign.notes || null,
      rewardType: campaign.reward_type || null,
      rewardAsset: campaign.reward_asset || null,
      rewardsDetail: campaign.rewards_detail || null,
      scoreBps: round(scoreBps, 4)
    });
  }

  return dedupeByKey(opportunities, (item) =>
    ["campaign", item.protocolUid, item.campaignName, item.assetSymbol, item.chainUid].join("|")
  );
}

function flattenPoolRows(payloads) {
  const values = Array.isArray(payloads) ? payloads : [payloads];
  return values.flatMap((payload) => {
    if (Array.isArray(payload?.data?.pools)) return payload.data.pools;
    if (Array.isArray(payload?.pools)) return payload.pools;
    return [];
  });
}

function allowlist(values) {
  return new Set((values || []).map((value) => String(value).toLowerCase()).filter(Boolean));
}

function stablecoinAllowlist(filters) {
  const explicit = [...allowlist(filters.assets), ...allowlist(filters.defiAssets)];
  return explicit.length ? new Set(explicit) : DEFAULT_STABLECOIN_IDS;
}

function isAllowedStablecoin(assetMasterUid, assetSymbol, allowed) {
  return allowed.has(assetMasterUid) || allowed.has(String(assetSymbol || "").toLowerCase());
}

function fractionToPct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number * 100;
}

function nullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, places) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** places;
  return Math.round(number * factor) / factor;
}

function dedupeByKey(opportunities, keyFn) {
  const byKey = new Map();
  for (const opportunity of opportunities) {
    const key = keyFn(opportunity);
    const existing = byKey.get(key);
    if (!existing || Number(opportunity.scoreBps || 0) > Number(existing.scoreBps || 0)) {
      byKey.set(key, opportunity);
    }
  }
  return [...byKey.values()];
}
