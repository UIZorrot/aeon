import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

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

async function main() {
  const jobId = process.env.JOB_ID || process.argv[2];
  const userQuery =
    process.env.USER_QUERY ||
    process.argv[3] ||
    "What perpetual and stablecoin arbitrage opportunities are available for Careful Finance?";
  const filters = parseJson(process.env.FILTERS || process.argv[4] || "{}");

  if (!jobId) throw new Error("JOB_ID is required");

  try {
    await ingest(jobId, { status: "running", result: null });

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
    const answer = await answerWithOptionalClaude({ userQuery, opportunities, filters });

    await ingest(jobId, {
      status: "completed",
      result: {
        answer,
        perpOpportunities,
        stablecoinDexOpportunities,
        stablecoinCexOpportunities,
        stablecoinOpportunities,
        opportunities,
        source: "astro_pulse+barker",
        generatedAt: new Date().toISOString(),
        diagnostics: {
          astroPulse: pulseResult.status,
          barkerLiquidity: barkerLiquidityResult.status,
          barkerDefi: barkerDefiResult.status,
          barkerLiquidityError:
            barkerLiquidityResult.status === "rejected" ? barkerLiquidityResult.reason?.message : null,
          barkerDefiError: barkerDefiResult.status === "rejected" ? barkerDefiResult.reason?.message : null,
          barkerDefiPartialErrors: barkerDefiResult.status === "fulfilled" ? barkerDefiResult.value.errors : []
        }
      }
    });
  } catch (error) {
    await ingest(jobId, {
      status: "failed",
      error: error.message,
      result: null
    });
    throw error;
  }
}

async function answerWithOptionalClaude({ userQuery, opportunities, filters }) {
  if (process.env.USE_CLAUDE_CODE !== "true") {
    return deterministicAnswer(opportunities);
  }

  const skill = await readFile("skills/careful-finance/SKILL.md", "utf8").catch(() => "");
  const prompt = [
    skill,
    "",
    "User query:",
    userQuery,
    "",
    "Filters:",
    JSON.stringify(filters, null, 2),
    "",
    "Opportunities JSON:",
    JSON.stringify(opportunities, null, 2)
  ].join("\n");

  return runClaude(prompt);
}

function deterministicAnswer(opportunities) {
  if (!opportunities.length) {
    return "No opportunities passed the current filters.";
  }

  const lines = opportunities.map((item, index) => {
    if (item.kind === "stablecoin_defi_campaign") {
      return [
        `${index + 1}. ${item.assetSymbol}: ${item.campaignName || item.protocolUid || "DeFi campaign"}`,
        `apy ${item.apyPct.toFixed(2)}%`,
        `lock ${item.lockDays || 0}d`,
        `tvl $${Number(item.tvlUsd || 0).toFixed(0)}`,
        `score ${item.scoreBps.toFixed(2)} bps`
      ].join(" | ");
    }

    if (item.kind === "stablecoin_defi_yield") {
      return [
        `${index + 1}. ${item.assetSymbol}: ${item.protocolName || "DeFi"} ${item.poolName || ""}`.trim(),
        `apy ${item.apyPct.toFixed(2)}%`,
        `chain ${item.chainUid || "unknown"}`,
        `tvl $${Number(item.tvlUsd || 0).toFixed(0)}`,
        `score ${item.scoreBps.toFixed(2)} bps`
      ].join(" | ");
    }

    if (item.kind === "stablecoin_cex") {
      return [
        `${index + 1}. ${item.symbol}: buy ${item.buyVenue} @ ${item.buyPrice}, sell ${item.sellVenue} @ ${item.sellPrice}`,
        `spread ${item.spreadBps.toFixed(2)} bps`,
        `depth $${Math.min(item.buyDepthUsd, item.sellDepthUsd).toFixed(0)}`,
        `score ${item.scoreBps.toFixed(2)} bps`
      ].join(" | ");
    }

    return [
      `${index + 1}. ${item.symbol}: long ${item.longVenue} @ ${item.longAsk}, short ${item.shortVenue} @ ${item.shortBid}`,
      `spread ${item.spreadBps.toFixed(2)} bps`,
      `funding carry ${item.fundingCarryBps.toFixed(2)} bps`,
      `score ${item.scoreBps.toFixed(2)} bps`
    ].join(" | ");
  });

  return ["Top opportunities after current filters:", ...lines].join("\n");
}

async function ingest(jobId, patch) {
  const ingestUrl = cleanEnv(process.env.AGENT_SERVICE_INGEST_URL);
  const ingestToken = cleanEnv(process.env.RUNNER_INGEST_TOKEN);
  if (!ingestUrl || !ingestToken) {
    console.log(JSON.stringify({ job_id: jobId, ...patch }, null, 2));
    return;
  }

  const response = await fetch(ingestUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ingestToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ job_id: jobId, ...patch })
  });

  if (!response.ok) {
    throw new Error(`ingest failed: ${response.status} ${await response.text()}`);
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

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "-"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited ${code}: ${stderr}`));
    });

    child.stdin.end(prompt);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
