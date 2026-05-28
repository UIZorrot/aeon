#!/usr/bin/env bash
set -euo pipefail

require() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required env var: $name" >&2
    exit 1
  fi
}

require AGENT_SERVICE_URL
require RUNNER_INGEST_TOKEN

if ! gh auth status >/dev/null 2>&1; then
  echo "gh CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

gh secret set AGENT_SERVICE_INGEST_URL --body "${AGENT_SERVICE_URL%/}/api/internal/ingest"
gh secret set AGENT_SERVICE_OPPORTUNITIES_URL --body "${AGENT_SERVICE_URL%/}/api/internal/opportunities"
gh secret set RUNNER_INGEST_TOKEN --body "$RUNNER_INGEST_TOKEN"

if [ -n "${BARKER_API_KEY:-}" ]; then
  gh secret set BARKER_API_KEY --body "$BARKER_API_KEY"
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  gh secret set ANTHROPIC_API_KEY --body "$ANTHROPIC_API_KEY"
fi

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  gh secret set CLAUDE_CODE_OAUTH_TOKEN --body "$CLAUDE_CODE_OAUTH_TOKEN"
fi

if [ -n "${BANKR_LLM_KEY:-}" ]; then
  gh secret set BANKR_LLM_KEY --body "$BANKR_LLM_KEY"
fi

gh variable set BARKER_DEFI_ASSETS --body "${BARKER_DEFI_ASSETS:-usdc,usdt,usde,usds,dai,pyusd,usd1,rlusd,crvusd,gho}"
gh variable set GITHUB_WORKFLOW_ID --body "careful-finance-agent.yml" >/dev/null 2>&1 || true

echo "Careful Finance GitHub secrets and variables configured."
