# IntraCloud Agent (Phase 2)

Cloudflare Worker + Llama-3.1 agent that:

- Discovers Uniswap v3 pools on Sepolia from factory `PoolCreated` events.
- Scores pools for prediction suitability (stability, manipulation resistance, profitability proxy).
- Selects the best pool and sets round config (`duration` + `twapWindow`) within contract limits.
- Generates a short prediction statement with Workers AI (`@cf/meta/llama-3.1-8b-instruct`).
- Calls `IntraPredictionMarket` on Sepolia to create rounds and resolve ended rounds.
- Stores latest analysis and recent ended rounds in Cloudflare KV for the web app.

## Contract target

- Chain: Sepolia (`11155111`)
- Contract: `0xEf16C4d27859F5D6Ab2506F7c3a1C0f199C18d89`

## Analysis factors

The agent uses onchain metrics only:

- Stability: short-vs-long TWAP drift plus liquidity quality.
- Manipulation resistance: pool liquidity and oracle observation depth.
- Profitability proxy: recent swap activity and fee-tier attractiveness.
- Signal quality: trend/momentum from recent TWAP and current tick.

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
```

3. Optional: protect manual trigger endpoint:

```bash
wrangler secret put RUN_AUTH_HEADER
```

4. Deploy:

```bash
wrangler deploy
```
