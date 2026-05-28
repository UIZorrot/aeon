const FUTURE_SUFFIX = "Future";

export function mergePulsePayloads(payloads) {
  const merged = { code: 0, data: {} };
  for (const payload of payloads) {
    for (const [key, value] of Object.entries(payload?.data || {})) {
      merged.data[key] = value;
    }
  }
  return merged;
}

export function buildPerpPerpOpportunities(payload, filters = {}) {
  const markets = extractFutureMarkets(payload, filters);
  const bySymbol = groupBy(markets, (market) => market.symbol);
  const minSpreadBps = numberOr(filters.minSpreadBps, 0);
  const maxSpreadBps = numberOr(filters.maxSpreadBps, 500);
  const maxAskBidSpreadBps = numberOr(filters.maxAskBidSpreadBps, 50);
  const minLiquidityUsd = numberOr(filters.minLiquidityUsd, 0);
  const maxResults = Math.min(Math.max(Math.round(numberOr(filters.maxResults, 10)), 1), 50);
  const opportunities = [];

  for (const [symbol, symbolMarkets] of bySymbol.entries()) {
    for (const longMarket of symbolMarkets) {
      for (const shortMarket of symbolMarkets) {
        if (longMarket.venue === shortMarket.venue) continue;
        if (longMarket.ask <= 0 || shortMarket.bid <= 0) continue;
        if (longMarket.liquidityUsd < minLiquidityUsd || shortMarket.liquidityUsd < minLiquidityUsd) continue;
        if (longMarket.marketSpreadBps > maxAskBidSpreadBps) continue;
        if (shortMarket.marketSpreadBps > maxAskBidSpreadBps) continue;

        const mid = (longMarket.ask + shortMarket.bid) / 2;
        const spreadBps = ((shortMarket.bid - longMarket.ask) / mid) * 10000;
        if (spreadBps < minSpreadBps) continue;
        if (spreadBps > maxSpreadBps) continue;

        const fundingCarryBps = shortMarket.fundingBps - longMarket.fundingBps;
        opportunities.push({
          kind: "perp_perp",
          source: "astro_pulse",
          symbol,
          longVenue: longMarket.venue,
          shortVenue: shortMarket.venue,
          longAsk: longMarket.ask,
          shortBid: shortMarket.bid,
          spreadBps: round(spreadBps, 4),
          longMarketSpreadBps: round(longMarket.marketSpreadBps, 4),
          shortMarketSpreadBps: round(shortMarket.marketSpreadBps, 4),
          longFundingBps: round(longMarket.fundingBps, 4),
          shortFundingBps: round(shortMarket.fundingBps, 4),
          fundingCarryBps: round(fundingCarryBps, 4),
          scoreBps: round(spreadBps + fundingCarryBps, 4),
          longLiquidityUsd: longMarket.liquidityUsd,
          shortLiquidityUsd: shortMarket.liquidityUsd
        });
      }
    }
  }

  return opportunities.sort((a, b) => b.scoreBps - a.scoreBps).slice(0, maxResults);
}

export function extractFutureMarkets(payload, filters = {}) {
  const data = payload?.data || {};
  const venueAllowlist = new Set((filters.venues || []).map((venue) => String(venue).toLowerCase()));
  const symbolAllowlist = new Set((filters.symbols || []).map((symbol) => String(symbol).toUpperCase()));
  const markets = [];

  for (const [key, value] of Object.entries(data)) {
    if (!key.endsWith(FUTURE_SUFFIX)) continue;

    const venue = normalizeVenue(key.slice(0, -FUTURE_SUFFIX.length));
    if (venueAllowlist.size && !venueAllowlist.has(venue)) continue;

    for (const row of value?.list || []) {
      const symbol = normalizeSymbol(row.name);
      if (!isTradablePerpSymbol(symbol)) continue;
      if (!symbol || (symbolAllowlist.size && !symbolAllowlist.has(symbol))) continue;

      const ask = Number(row.a);
      const bid = Number(row.b);
      if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0 || ask < bid) continue;

      const mid = (ask + bid) / 2;
      markets.push({
        venue,
        symbol,
        ask,
        bid,
        marketSpreadBps: ((ask - bid) / mid) * 10000,
        fundingBps: Number(row.rate || 0) * 100,
        liquidityUsd: Number(row.trade24Count || 0)
      });
    }
  }

  return markets;
}

function normalizeVenue(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === "hl") return "hyperliquid";
  return normalized;
}

function normalizeSymbol(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
}

function isTradablePerpSymbol(symbol) {
  if (!symbol) return false;
  if (["USDT", "USDC", "USD"].includes(symbol)) return false;
  return symbol.endsWith("USDT") && symbol.length > 4;
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
