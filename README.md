<p align="center">
  <img src="./agent.png" alt="IntraCloud Agent" width="100%" />
</p>

<h1 align="center">IntraCloud Agent</h1>

<p align="center">
  <strong>Autonomous Market Intelligence Engine · Cloudflare Workers + Llama-3.1</strong>
</p>

---

## Overview

The IntraCloud Agent is a serverless autonomous actor deployed on Cloudflare Workers that continuously analyzes Uniswap v3/v4 pool dynamics to identify optimal prediction targets. It combines on-chain RPC inspection, Uniswap SDK price math, Trade API routing diagnostics, and subgraph-sourced liquidity signals into a composite scoring model—then autonomously deploys and resolves prediction rounds against the `IntraPredictionMarket` contract.

The agent operates on a scheduled cadence: discover pools → score candidates → select the highest-signal pair → calibrate round parameters → create on-chain round → resolve expired rounds → persist analysis state.

## Capabilities

- **Pool Discovery** — Indexes `PoolCreated` events from Uniswap v3 Factory on Sepolia; augments candidate set via v3 subgraph when configured
- **Multi-Source Scoring** — Evaluates TWAP drift, oracle cardinality, liquidity depth, swap frequency, and manipulation resistance across on-chain and off-chain sources
- **Trade API Integration** — Probes Uniswap Trade API for v3/v4 route quality, price impact diagnostics, and routing confidence signals
- **SDK Validation** — Uses `@uniswap/v3-sdk` for tick-to-price drift computation and `@uniswap/v4-sdk` for pool ID verification on v4-routed quotes
- **Autonomous Round Management** — Selects duration (5–15 min) and TWAP window (30–300s) based on pool volatility profile; creates and resolves rounds via contract calls
- **Prediction Generation** — Produces directional price statements via Workers AI (`@cf/meta/llama-3.1-8b-instruct`) grounded in quantitative analysis
- **State Persistence** — Stores latest analysis summaries and recent round history in Cloudflare KV for consumption by the web application

## Analysis Pipeline

```
Uniswap v3 Factory Events ─┐
Uniswap v3 Subgraph ───────┤
Uniswap Trade API ──────────┼──▶ Composite Scoring ──▶ Pool Selection ──▶ Round Creation
Uniswap v3 SDK (price) ────┤                              │
Uniswap v4 SDK (pool ID) ──┘                              ▼
                                                    On-Chain Settlement
```

## Scoring Dimensions

| Factor | Source | Signal |
|--------|--------|--------|
| TWAP Stability | On-chain `observe()` | Low drift indicates oracle reliability |
| Oracle Depth | On-chain cardinality | Higher cardinality = harder to manipulate |
| Liquidity Depth | RPC + Subgraph | Deeper liquidity resists price manipulation |
| Swap Frequency | Subgraph volume data | Active pools produce meaningful price movement |
| Route Quality | Trade API quotes | v3/v4 routing confidence and price impact |
| v4 Participation | Trade API + v4 SDK | Cross-version liquidity availability |

## API Surface

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | `GET` | Runtime health check |
| `/analysis/latest` | `GET` | Most recent pool analysis and prediction rationale |
| `/rounds/recent` | `GET` | Recently completed prediction rounds |
| `/stats` | `GET` | Aggregate platform statistics |
| `/run` | `POST` | Manual trigger (authenticated) |

## Target Contract

| Parameter | Value |
|-----------|-------|
| Network | Sepolia (`11155111`) |
| Contract | `0xEf16C4d27859F5D6Ab2506F7c3a1C0f199C18d89` |

## License

MIT
