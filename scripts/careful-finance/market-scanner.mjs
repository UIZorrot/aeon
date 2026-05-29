import { buildPerpPerpOpportunities, mergePulsePayloads } from "./lib/astro-opportunities.mjs";
import { buildStablecoinDefiOpportunities } from "./lib/barker-defi-opportunities.mjs";
import { buildStablecoinCexOpportunities } from "./lib/barker-stablecoin-opportunities.mjs";

const DEFAULT_ASTRO_URL = "https://pulse-api.astro-btc.xyz/api/query/second";
const DEFAULT_ASTRO_LITE_URL = "https://pulse-lite-api.astro-btc.xyz/api/query/new";
const DEFAULT_BARKER_LIQUIDITY_URL = "https://app.barker.money/api/liquidity/overview";
const DEFAULT_BARKER_VAULT_POOLS_URL = "https://app.barker.money/api/vaults/pools";
const DEFAULT_BARKER_CAMPAIGNS_URL = "https://app.barker.money/api/protocols/campaigns";
const DEFAULT_BARKER_API_KEY =
  "1a2989ae823ca2a0d3a46034804a920259d194cb8c92969fbc397a25674682ce7e758645472433424668e27d6f3a23d3ac8719e424a6d01f054b1f8b79c56fd3";
const DEFAULT_BARKER_DEFI_ASSETS = ["usdc", "usdt", "usde", "usds", "dai", "pyusd", "usd1", "rlusd", "crvusd", "gho"];
const DEFAULT_FILTERS = {
  venues: ["bitget", "binance", "okx", "aster", "hyperliquid"],
  minSpreadBps: 5,
  maxSpreadBps: 500,
  maxAskBidSpreadBps: 50,
  maxSingleSideCostPct: 1,
  minDepthUsd: 50000,
  minDefiApyPct: 3,
  minDefiTvlUsd: 1000000,
  maxDefiLockDays: 120,
  maxResults: 25,
  includeFunding: true
};

async function main() {
  const filters = {
    ...DEFAULT_FILTERS,
    ...parseJson(process.env.FILTERS || "{}")
  };

  const barkerHeaders = { "x-api-key": process.env.BARKER_API_KEY || DEFAULT_BARKER_API_KEY };
  const [pulseResult, barkerLiquidityResult, barkerDefiResult] = await Promise.allSettled([
    Promise.all([
      fetchJsonWithRetry(process.env.ASTRO_PULSE_LITE_URL || DEFAULT_ASTRO_LITE_URL),
      fetchJsonWithRetry(process.env.ASTRO_PULSE_SECOND_URL || DEFAULT_ASTRO_URL)
    ]).then(mergePulsePayloads),
    fetchJsonWithRetry(process.env.BARKER_LIQUIDITY_OVERVIEW_URL || DEFAULT_BARKER_LIQUIDITY_URL, barkerHeaders),
    fetchBarkerDefiPayloads(filters, barkerHeaders)
  ]);

  const perpOpportunities =
    pulseResult.status === "fulfilled" ? buildPerpPerpOpportunities(pulseResult.value, filters) : [];
  const stablecoinCexOpportunities =
    barkerLiquidityResult.status === "fulfilled"
      ? buildStablecoinCexOpportunities(barkerLiquidityResult.value, filters)
      : [];
  const stablecoinDexOpportunities =
    barkerDefiResult.status === "fulfilled" ? buildStablecoinDefiOpportunities(barkerDefiResult.value, filters) : [];
  const stablecoinOpportunities = [...stablecoinDexOpportunities, ...stablecoinCexOpportunities]
    .sort((a, b) => Number(b.scoreBps || 0) - Number(a.scoreBps || 0))
    .slice(0, Math.min(Math.max(Math.round(Number(filters.maxResults) || 25), 1), 100));
  const opportunities = [...perpOpportunities, ...stablecoinOpportunities]
    .sort((a, b) => Number(b.scoreBps || 0) - Number(a.scoreBps || 0))
    .slice(0, Math.min(Math.max(Math.round(Number(filters.maxResults) || 25), 1), 100));
  const snapshot = {
    source: "astro_pulse+barker",
    generatedAt: new Date().toISOString(),
    filters,
    perpOpportunities,
    stablecoinDexOpportunities,
    stablecoinCexOpportunities,
    stablecoinOpportunities,
    opportunities,
    diagnostics: {
      astroPulse: pulseResult.status,
      barkerLiquidity: barkerLiquidityResult.status,
      barkerDefi: barkerDefiResult.status,
      barkerLiquidityError:
        barkerLiquidityResult.status === "rejected" ? barkerLiquidityResult.reason?.message : null,
      barkerDefiError: barkerDefiResult.status === "rejected" ? barkerDefiResult.reason?.message : null,
      barkerDefiPartialErrors: barkerDefiResult.status === "fulfilled" ? barkerDefiResult.value.errors : []
    }
  };

  await publish(snapshot);
}

async function publish(snapshot) {
  const url = cleanEnv(process.env.AGENT_SERVICE_OPPORTUNITIES_URL);
  const token = cleanEnv(process.env.RUNNER_INGEST_TOKEN);

  if (!url || !token) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(snapshot)
  });

  if (!response.ok) {
    throw new Error(`opportunity publish failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(process.env.FETCH_TIMEOUT_MS || 15000)));
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "CarefulFinance/0.1", ...headers },
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function fetchJsonWithRetry(url, headers = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchJson(url, headers);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function fetchBarkerDefiPayloads(filters, headers) {
  const assets = parseCsv(process.env.BARKER_DEFI_ASSETS || "")
    .concat(filters.defiAssets || [])
    .map((asset) => String(asset).toLowerCase())
    .filter(Boolean);
  const uniqueAssets = [...new Set(assets.length ? assets : DEFAULT_BARKER_DEFI_ASSETS)];
  const poolsUrl = process.env.BARKER_VAULT_POOLS_URL || DEFAULT_BARKER_VAULT_POOLS_URL;
  const campaignsUrl = process.env.BARKER_CAMPAIGNS_URL || DEFAULT_BARKER_CAMPAIGNS_URL;
  const minTvlUsd = Math.max(0, Math.round(numberOr(filters.minDefiTvlUsd ?? filters.minTvlUsd, 1_000_000)));

  const [campaignsResult, ...poolResults] = await Promise.allSettled([
    fetchJsonWithRetry(campaignsUrl, headers),
    ...uniqueAssets.map((asset) => fetchJsonWithRetry(withQuery(poolsUrl, { vault_asset_uid: asset, tvl_min: minTvlUsd }), headers))
  ]);

  return {
    campaignsPayload: campaignsResult.status === "fulfilled" ? campaignsResult.value : null,
    poolsPayloads: poolResults.filter((result) => result.status === "fulfilled").map((result) => result.value),
    errors: [campaignsResult, ...poolResults]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || String(result.reason))
  };
}

function withQuery(url, params) {
  const nextUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") nextUrl.searchParams.set(key, String(value));
  }
  return nextUrl.toString();
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function cleanEnv(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
