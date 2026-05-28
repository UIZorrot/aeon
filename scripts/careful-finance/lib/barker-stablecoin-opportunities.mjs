const DEFAULT_TIER = "10k";

export function buildStablecoinCexOpportunities(payload, filters = {}) {
  const tier = normalizeTier(filters.tier || DEFAULT_TIER);
  const markets = extractStablecoinCexMarkets(payload, { ...filters, tier });
  const byAsset = groupBy(markets, (market) => market.assetUid);
  const minSpreadBps = numberOr(filters.minStablecoinSpreadBps ?? filters.minSpreadBps, 5);
  const maxSingleSideCostPct = numberOr(filters.maxSingleSideCostPct, 1);
  const minDepthUsd = numberOr(filters.minDepthUsd, 50_000);
  const maxResults = Math.min(Math.max(Math.round(numberOr(filters.maxResults, 25)), 1), 100);
  const opportunities = [];

  for (const [assetUid, assetMarkets] of byAsset.entries()) {
    for (const buyMarket of assetMarkets) {
      for (const sellMarket of assetMarkets) {
        if (buyMarket.venue === sellMarket.venue) continue;
        if (buyMarket.buyPrice <= 0 || sellMarket.sellPrice <= 0) continue;
        if (buyMarket.buyDepthUsd < minDepthUsd || sellMarket.sellDepthUsd < minDepthUsd) continue;
        if (buyMarket.buyCostPct > maxSingleSideCostPct) continue;
        if (sellMarket.sellCostPct > maxSingleSideCostPct) continue;

        const mid = (buyMarket.buyPrice + sellMarket.sellPrice) / 2;
        const spreadBps = ((sellMarket.sellPrice - buyMarket.buyPrice) / mid) * 10000;
        if (spreadBps < minSpreadBps) continue;

        opportunities.push({
          kind: "stablecoin_cex",
          source: "barker",
          assetUid,
          masterUid: buyMarket.masterUid,
          symbol: buyMarket.symbol,
          chainUid: buyMarket.chainUid,
          tier,
          pair: buyMarket.pair,
          buyVenue: buyMarket.venue,
          sellVenue: sellMarket.venue,
          buyPrice: buyMarket.buyPrice,
          sellPrice: sellMarket.sellPrice,
          spreadBps: round(spreadBps, 4),
          buyCostPct: buyMarket.buyCostPct,
          sellCostPct: sellMarket.sellCostPct,
          buyDepthUsd: buyMarket.buyDepthUsd,
          sellDepthUsd: sellMarket.sellDepthUsd,
          scoreBps: round(spreadBps, 4)
        });
      }
    }
  }

  return dedupeOpportunities(opportunities)
    .sort((a, b) => b.scoreBps - a.scoreBps)
    .slice(0, maxResults);
}

export function extractStablecoinCexMarkets(payload, filters = {}) {
  const tier = normalizeTier(filters.tier || DEFAULT_TIER);
  const venueAllowlist = new Set((filters.venues || []).map((venue) => String(venue).toLowerCase()));
  const assetAllowlist = new Set((filters.assets || []).map((asset) => String(asset).toLowerCase()));
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const markets = [];

  for (const row of rows) {
    const asset = row?.asset || {};
    const symbol = String(asset.symbol || "").toUpperCase();
    const assetUid = String(asset.assetUid || "");
    const masterUid = String(asset.masterUid || "").toLowerCase();
    if (!symbol || !assetUid) continue;
    if (assetAllowlist.size && !assetAllowlist.has(masterUid) && !assetAllowlist.has(symbol.toLowerCase())) {
      continue;
    }

    for (const exchange of row?.exitPaths?.cex?.exchanges || []) {
      const venue = String(exchange.exchange || "").toLowerCase();
      if (!venue || (venueAllowlist.size && !venueAllowlist.has(venue))) continue;

      for (const pair of exchange.pairs || []) {
        const buy = pair.buy || {};
        const sell = pair.sell || {};
        const buyPrice = numberOr(buy[`price_${tier}`], NaN);
        const sellPrice = numberOr(sell[`price_${tier}`], NaN);
        if (!Number.isFinite(buyPrice) || !Number.isFinite(sellPrice)) continue;

        markets.push({
          venue,
          assetUid,
          masterUid,
          symbol,
          chainUid: asset.chainUid || null,
          pair: pair.symbol || null,
          buyPrice,
          sellPrice,
          buyCostPct: numberOr(buy[`cost_${tier}_pct`], 0),
          sellCostPct: numberOr(sell[`cost_${tier}_pct`], 0),
          buyDepthUsd: numberOr(buy.depth_2pct, 0),
          sellDepthUsd: numberOr(sell.depth_2pct, 0)
        });
      }
    }
  }

  return markets;
}

function normalizeTier(value) {
  const tier = String(value).replace(/[^0-9k]/gi, "").toLowerCase();
  return ["1k", "10k", "100k"].includes(tier) ? tier : DEFAULT_TIER;
}

function groupBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function dedupeOpportunities(opportunities) {
  const byRoute = new Map();

  for (const opportunity of opportunities) {
    const key = [
      opportunity.masterUid || opportunity.symbol,
      opportunity.pair,
      opportunity.tier,
      opportunity.buyVenue,
      opportunity.sellVenue,
      opportunity.buyPrice,
      opportunity.sellPrice
    ].join("|");
    const existing = byRoute.get(key);
    if (!existing || routeLiquidity(opportunity) > routeLiquidity(existing)) {
      byRoute.set(key, opportunity);
    }
  }

  return [...byRoute.values()];
}

function routeLiquidity(opportunity) {
  return Math.min(Number(opportunity.buyDepthUsd || 0), Number(opportunity.sellDepthUsd || 0));
}
