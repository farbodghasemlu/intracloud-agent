# IntraCloud Agent (Phase 2)

Cloudflare Worker + Llama-3.1 agent that:

- Discovers Uniswap v3 pools on Sepolia from factory `PoolCreated` events.
- Augments discovery with Uniswap v3 subgraph candidates (when configured).
- Scores pools for prediction suitability (stability, manipulation resistance, profitability proxy).
- Selects the best pool and sets round config (`duration` + `twapWindow`) within contract limits.
- Probes Uniswap Trade API quotes (v3/v4 routing) to refine confidence and round timing.
- Validates v4 route pool IDs with the official `@uniswap/v4-sdk`.
- Uses `@uniswap/v3-sdk` price math for drift/quality signals.
- Generates a short prediction statement with Workers AI (`@cf/meta/llama-3.1-8b-instruct`).
- Calls `IntraPredictionMarket` on Sepolia to create rounds and resolve ended rounds.
- Stores latest analysis and recent ended rounds in Cloudflare KV for the web app.

## Contract target

- Chain: Sepolia (`11155111`)
- Contract: `0xEf16C4d27859F5D6Ab2506F7c3a1C0f199C18d89`

## Analysis factors

The agent uses multiple Uniswap-native sources:

- Onchain RPC (Uniswap v3 pools): TWAP drift, liquidity, oracle depth, swap activity.
- Uniswap SDKs: v3 tick-to-price drift and v4 pool-id validation.
- Uniswap Trade API: quote route, v4 participation, and price impact diagnostics.
- Uniswap subgraphs (optional): v3 candidate pools and v4 market-wide regime snapshot.
- Uniswap AI context file (optional): prompt grounding for consistent terminology.

Scoring output drives both pool selection and round setup:

- `duration`: clamped to `5-15` minutes.
- `twapWindow`: clamped to `30-300` seconds and always `<= duration`.

## Runtime endpoints

- `GET /health`
- `GET /analysis/latest`
- `GET /rounds/recent`
- `GET /stats`
- `POST /run` (optional auth via `RUN_AUTH_HEADER`)

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

## Verification

```bash
npm run typecheck
npm test
```

## Deployment

1. Create and bind a KV namespace (`AGENT_STATE`) and set `id`/`preview_id` in `wrangler.toml`.
2. Set Worker secrets:

```bash
wrangler secret put SEPOLIA_RPC_URL
wrangler secret put SEPOLIA_PRIVATE_KEY
wrangler secret put UNISWAP_API_KEY
```

3. Optional: set subgraph endpoints if you want deeper v3/v4 data in scoring:

```bash
wrangler secret put UNISWAP_V3_SUBGRAPH_URL
wrangler secret put UNISWAP_V4_SUBGRAPH_URL
```

4. Optional: protect manual trigger endpoint:

```bash
wrangler secret put RUN_AUTH_HEADER
```

5. Deploy:

```bash
wrangler deploy
```
