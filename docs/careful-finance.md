# Careful Finance Aeon Integration

Careful Finance exposes Aeon as a 24/7 informational agent for perpetual futures and stablecoin opportunities.

## Components

- `skills/careful-finance/SKILL.md` is the Aeon-native skill for manual or scheduled summaries.
- `.github/workflows/careful-finance-market-scanner.yml` refreshes the Vercel opportunity cache every 5 minutes.
- `.github/workflows/careful-finance-agent.yml` answers live ChatUI jobs dispatched by the Vercel service.
- `scripts/careful-finance/` contains the deterministic market parsers and runner scripts.

## Required Repository Secrets

- `AGENT_SERVICE_INGEST_URL`: `https://<careful-finance-vercel>/api/internal/ingest`
- `AGENT_SERVICE_OPPORTUNITIES_URL`: `https://<careful-finance-vercel>/api/internal/opportunities`
- `RUNNER_INGEST_TOKEN`: shared secret matching the Vercel app

## Optional Repository Secrets

- `BARKER_API_KEY`: override Barker's public frontend key if a partner key is issued
- `ANTHROPIC_API_KEY`
- `CLAUDE_CODE_OAUTH_TOKEN`
- `BANKR_LLM_KEY`

## Optional Repository Variables

- `BARKER_DEFI_ASSETS`: defaults to `usdc,usdt,usde,usds,dai,pyusd,usd1,rlusd,crvusd,gho`
- `ASTRO_PULSE_SECOND_URL`
- `ASTRO_PULSE_LITE_URL`
- `BARKER_LIQUIDITY_OVERVIEW_URL`
- `BARKER_VAULT_POOLS_URL`
- `BARKER_CAMPAIGNS_URL`
- `USE_CLAUDE_CODE=true` to let Claude Code rewrite the deterministic answer

## Vercel Service Settings

Point the Careful Finance Vercel service at this Aeon repository:

- `GITHUB_OWNER=<owner>`
- `GITHUB_REPO=<aeon-repo>`
- `GITHUB_WORKFLOW_ID=careful-finance-agent.yml`
- `GITHUB_REF=main`

The ChatUI uses cache first. It dispatches `careful-finance-agent.yml` only when the cache is stale or the request body includes `forceLive: true`.

## Manual Runs

Refresh the cache:

```bash
gh workflow run careful-finance-market-scanner.yml -f filters='{"maxResults":10}'
```

Run a live answer job:

```bash
gh workflow run careful-finance-agent.yml \
  -f job_id=manual_test \
  -f user_query="What opportunities are available?" \
  -f filters='{"maxResults":10}'
```

Run the Aeon-native skill:

```bash
gh workflow run aeon.yml -f skill=careful-finance -f var='{"maxResults":10,"minDefiApyPct":3}'
```

## Configure GitHub Secrets

After `gh auth login`, run:

```bash
export AGENT_SERVICE_URL="https://careful-finance.vercel.app"
export RUNNER_INGEST_TOKEN="<same value as Vercel RUNNER_INGEST_TOKEN>"
export ANTHROPIC_API_KEY="sk-ant-api..."
./scripts/careful-finance/configure-github.sh
```

`ANTHROPIC_API_KEY` is supported directly. `CLAUDE_CODE_OAUTH_TOKEN` remains optional for subscription-backed runs.
