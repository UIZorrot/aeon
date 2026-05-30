import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

async function main() {
  const publishUrl = cleanEnv(process.env.AGENT_SERVICE_OPPORTUNITIES_URL);
  const ingestToken = cleanEnv(process.env.RUNNER_INGEST_TOKEN);
  const snapshotUrl = deriveSnapshotUrl(publishUrl, process.env.AGENT_SERVICE_SNAPSHOT_URL);

  if (!publishUrl || !ingestToken || !snapshotUrl) {
    throw new Error("AGENT_SERVICE_OPPORTUNITIES_URL, RUNNER_INGEST_TOKEN, and a readable snapshot URL are required");
  }

  const payload = await fetchJson(snapshotUrl);
  const snapshot = payload?.snapshot || payload;
  if (!snapshot || !Array.isArray(snapshot.opportunities)) {
    throw new Error("No opportunity snapshot is available to analyze");
  }

  const structured = buildStructuredAnalysis(snapshot);
  const summaryMarkdown = await buildSummaryMarkdown(snapshot, structured);
  const nextSnapshot = {
    ...snapshot,
    analysis: {
      source: "aeon-market-analysis",
      generatedAt: new Date().toISOString(),
      model: process.env.USE_CLAUDE_CODE === "true" ? "claude-code" : "deterministic",
      summaryMarkdown,
      structured
    }
  };

  await publishSnapshot(publishUrl, ingestToken, nextSnapshot);
}

async function buildSummaryMarkdown(snapshot, structured) {
  if (process.env.USE_CLAUDE_CODE !== "true") {
    return deterministicSummaryMarkdown(snapshot, structured);
  }

  const skill = await readFile("skills/careful-finance/SKILL.md", "utf8").catch(() => "");
  const prompt = [
    skill,
    "",
    "Write a detailed but operational market analysis for Careful Finance.",
    "The audience is a frontend LLM that will use this cached analysis to answer later user questions.",
    "Keep it structured, specific, and conservative. Do not invent data.",
    "Include sections for summary, market regime, best current setups, main risks, and what to watch next.",
    "",
    "Snapshot metadata:",
    JSON.stringify(
      {
        source: snapshot.source,
        generatedAt: snapshot.generatedAt,
        diagnostics: snapshot.diagnostics || {}
      },
      null,
      2
    ),
    "",
    "Structured opportunity digest:",
    JSON.stringify(structured, null, 2),
    "",
    "Top opportunities JSON:",
    JSON.stringify((snapshot.opportunities || []).slice(0, 12), null, 2)
  ].join("\n");

  try {
    const output = await runClaude(prompt);
    return output || deterministicSummaryMarkdown(snapshot, structured);
  } catch {
    return deterministicSummaryMarkdown(snapshot, structured);
  }
}

function deterministicSummaryMarkdown(snapshot, structured) {
  const lines = [
    "## Summary",
    `- Snapshot source: ${snapshot.source || "unknown"} at ${snapshot.generatedAt || "unknown time"}.`,
    `- Current mix: ${structured.counts.stablecoinDefi} stablecoin DeFi, ${structured.counts.perpSpread} perp spread, ${structured.counts.stablecoinCex} stablecoin CEX.`,
    `- Market bias: ${structured.marketBias.join(", ") || "mixed"}.`,
    "",
    "## Best Current Setups"
  ];

  for (const item of structured.topOpportunities.slice(0, 5)) {
    lines.push(`- ${item.label}: ${item.primaryMetric}; ${item.commentary}`);
  }

  lines.push("", "## Main Risks");
  for (const risk of structured.risks.slice(0, 6)) {
    lines.push(`- ${risk}`);
  }

  lines.push("", "## What To Watch Next");
  for (const watch of structured.watchlist.slice(0, 4)) {
    lines.push(`- ${watch}`);
  }

  return lines.join("\n");
}

function buildStructuredAnalysis(snapshot) {
  const opportunities = Array.isArray(snapshot.opportunities) ? snapshot.opportunities : [];
  const perpOpportunities = Array.isArray(snapshot.perpOpportunities) ? snapshot.perpOpportunities : [];
  const stablecoinDefi = Array.isArray(snapshot.stablecoinDexOpportunities) ? snapshot.stablecoinDexOpportunities : [];
  const stablecoinCex = Array.isArray(snapshot.stablecoinCexOpportunities) ? snapshot.stablecoinCexOpportunities : [];
  const topOpportunities = opportunities
    .slice(0, 8)
    .map((item) => ({
      kind: item.kind,
      label: labelFor(item),
      primaryMetric: primaryMetric(item),
      scoreBps: Number(item.scoreBps || 0),
      commentary: commentaryFor(item)
    }));

  return {
    counts: {
      total: opportunities.length,
      perpSpread: perpOpportunities.length,
      stablecoinDefi: stablecoinDefi.length,
      stablecoinCex: stablecoinCex.length
    },
    marketBias: deriveMarketBias({ perpOpportunities, stablecoinDefi, stablecoinCex }),
    topOpportunities,
    risks: deriveRisks(snapshot, opportunities),
    watchlist: deriveWatchlist(opportunities)
  };
}

function deriveMarketBias({ perpOpportunities, stablecoinDefi, stablecoinCex }) {
  const flags = [];
  if (stablecoinDefi.length >= perpOpportunities.length && stablecoinDefi.length > 0) {
    flags.push("stablecoin-defi-led");
  }
  if (perpOpportunities.some((item) => Number(item.askBidSpreadBps || 0) <= 20)) {
    flags.push("perp-execution-looks-healthy");
  }
  if (stablecoinCex.length === 0) {
    flags.push("cex-routes-thin");
  }
  if (!flags.length) flags.push("mixed");
  return flags;
}

function deriveRisks(snapshot, opportunities) {
  const risks = [];
  const diagnostics = snapshot.diagnostics || {};

  if (diagnostics.astroPulse === "rejected") risks.push("Astro Pulse data failed on the latest scan.");
  if (diagnostics.barkerLiquidity === "rejected") risks.push("Barker liquidity data failed on the latest scan.");
  if (diagnostics.barkerDefi === "rejected") risks.push("Barker DeFi data failed on the latest scan.");

  if (opportunities.some((item) => Number(item.askBidSpreadBps || 0) > 25)) {
    risks.push("Some perp spreads rely on wider ask-bid conditions and may degrade during execution.");
  }
  if (opportunities.some((item) => Number(item.lockDays || 0) > 30)) {
    risks.push("Part of the stablecoin yield set depends on longer lockups.");
  }
  if (opportunities.some((item) => Number(item.depthUsd || item.buyDepthUsd || 0) < 100000)) {
    risks.push("Several opportunities still have moderate depth rather than deep institutional liquidity.");
  }
  if (!risks.length) {
    risks.push("No exceptional risk flags were detected beyond normal execution, protocol, and venue risk.");
  }

  return risks;
}

function deriveWatchlist(opportunities) {
  const watch = [];
  const topPerp = opportunities.find((item) => item.kind === "perp_perp");
  const topDefi = opportunities.find((item) =>
    ["stablecoin_defi_yield", "stablecoin_defi_campaign"].includes(item.kind)
  );
  const topCex = opportunities.find((item) => item.kind === "stablecoin_cex");

  if (topPerp) {
    watch.push(`${topPerp.symbol} perp spread durability between ${topPerp.longVenue} and ${topPerp.shortVenue}.`);
  }
  if (topDefi) {
    watch.push(`${topDefi.assetSymbol} yield persistence on ${topDefi.protocolName || topDefi.campaignName || "DeFi"}.`);
  }
  if (topCex) {
    watch.push(`${topCex.symbol} transferability and venue depth across ${topCex.buyVenue} and ${topCex.sellVenue}.`);
  }
  if (!watch.length) {
    watch.push("Wait for the next scan cycle before drawing market-structure conclusions.");
  }

  return watch;
}

function labelFor(item) {
  if (item.kind === "stablecoin_defi_yield") return `${item.assetSymbol} / ${item.protocolName || "DeFi"}`;
  if (item.kind === "stablecoin_defi_campaign") return `${item.assetSymbol} / ${item.campaignName || "Campaign"}`;
  if (item.kind === "stablecoin_cex") return `${item.symbol} / ${item.buyVenue}->${item.sellVenue}`;
  return `${item.symbol} / ${item.longVenue}->${item.shortVenue}`;
}

function primaryMetric(item) {
  if (item.kind === "stablecoin_defi_yield" || item.kind === "stablecoin_defi_campaign") {
    return `apy ${Number(item.apyPct || 0).toFixed(2)}%`;
  }
  return `spread ${Number(item.spreadBps || 0).toFixed(2)} bps`;
}

function commentaryFor(item) {
  if (item.kind === "stablecoin_defi_yield" || item.kind === "stablecoin_defi_campaign") {
    return `TVL $${Number(item.tvlUsd || 0).toFixed(0)} on ${item.chainUid || "unknown"} with lock ${item.lockDays || 0}d`;
  }
  if (item.kind === "stablecoin_cex") {
    return `buy ${item.buyVenue}, sell ${item.sellVenue}, depth $${Number(item.depthUsd || item.buyDepthUsd || 0).toFixed(0)}`;
  }
  return `carry ${Number(item.fundingCarryBps || 0).toFixed(2)} bps and ask-bid ${Number(item.askBidSpreadBps || 0).toFixed(2)} bps`;
}

async function publishSnapshot(url, token, snapshot) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(snapshot)
  });

  if (!response.ok) {
    throw new Error(`snapshot publish failed: ${response.status} ${await response.text()}`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "CarefulFinanceAnalysis/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`snapshot fetch failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

function deriveSnapshotUrl(publishUrl, explicitUrl) {
  const cleanExplicit = cleanEnv(explicitUrl);
  if (cleanExplicit) return cleanExplicit;
  if (!publishUrl) return "";
  return publishUrl.replace(/\/api\/internal\/opportunities\/?$/, "/api/opportunities");
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
