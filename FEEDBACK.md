# FEEDBACK.md

## Project

IntraCloud: autonomous prediction market agent that uses the Uniswap stack for pool intelligence and on-chain TWAP settlement.

## What We Used

- **Uniswap v3 SDK (`@uniswap/v3-sdk`)**: tick-to-price conversion, price drift computation, pool math
- **Uniswap v4 SDK (`@uniswap/v4-sdk`)**: pool ID validation for Trade API routed quotes
- **Uniswap Trade API**: quote routing across v3/v4 liquidity, price impact diagnostics
- **Uniswap v3 Subgraph**: candidate pool discovery, historical volume and TVL signals
- **Uniswap v3 on-chain TWAP (`observe()`)**: sole price resolution mechanism for prediction settlement

## What Worked Well

The v3 SDK is solid. Tick math, price conversion, and pool instantiation are well-documented and predictable. We leaned heavily on `tickToPrice` and `Pool.getOutputAmount` for drift signals and they behaved exactly as expected.

The Trade API quote endpoint was surprisingly useful beyond its intended purpose. We used it not for executing swaps but as a confidence signal. If the router returns a clean v3/v4 split with low price impact, that tells the agent the pool has real depth and active liquidity. This worked reliably throughout development.

On-chain `observe()` for TWAP was the most important integration for us since it's our entire settlement layer. It's simple, deterministic, and exactly what a prediction market needs. No off-chain dependencies, no oracle risk. The oracle is just there, built into every pool, and it works.

## What Didn't Work / Friction

**Trade API documentation gaps.** The response schema for quote routes isn't fully documented. We had to reverse-engineer which fields indicate v4 participation vs pure v3 routing. A clear field like `routeVersion` or `poolVersions[]` in the response would save significant time. We ended up cross-validating pool IDs with the v4 SDK to confirm v4 involvement, which felt like a workaround.

**v4 SDK maturity.** The v4 SDK is usable but feels early. Pool ID construction and validation work, but the documentation assumes familiarity with v4 internals that aren't well-explained for developers coming from v3. The relationship between v4 pool IDs in Trade API responses and the SDK's own ID computation wasn't obvious, and we spent time verifying they match.

**Subgraph reliability.** The hosted v3 subgraph occasionally lagged behind chain state by 20-30 blocks during our testing on Sepolia. For an agent that scores pools in real-time, stale subgraph data means stale candidate lists. We built a fallback path using direct Factory event indexing via RPC, but it would be better if the subgraph had a `_meta` field that clearly indicated how far behind it was so we could programmatically decide whether to trust it.

**Sepolia pool scarcity.** Building on Sepolia meant very few active pools with meaningful liquidity and oracle history. Most pools had zero or minimal `observe()` cardinality, which made testing the scoring model difficult. We ended up creating our own test pools to get realistic oracle data, which added significant development time.

**TWAP window edge cases.** The `observe()` function reverts if you request a window longer than the pool's observation cardinality supports. This is correct behavior, but the error message is opaque and just reverts with no reason string. A descriptive revert like `"OracleCardinalityInsufficient(requested, available)"` would save debugging time. We had to add defensive cardinality checks before every `observe()` call.

## Docs Gaps

- Trade API response schema needs a complete reference, not just example responses. Specifically: what does the `routing` field contain when v4 pools are involved, and how do you distinguish a pure v3 route from a v3+v4 split?
- v4 SDK README assumes you already know how v4 pool IDs are structured. A "coming from v3" migration section would help.
- No documentation on using `observe()` for non-trading use cases like settlement or monitoring. The docs frame it entirely around TWAP oracle integration for AMM purposes, but it's equally valuable for external consumers.
- Subgraph schema docs for Sepolia are sparse. The mainnet subgraph docs exist but don't call out which fields or entities behave differently on testnets.

## Missing Endpoints / What We Wish Existed

- **Pool health or pool quality endpoint** on the Trade API. Something that returns liquidity depth, oracle cardinality, recent swap count, and estimated manipulation cost for a given pool address. We built this scoring ourselves from raw RPC calls and subgraph queries, but it feels like something Uniswap could expose natively since they have all the data.
- **WebSocket or streaming endpoint for pool state changes.** We poll via RPC on a cron schedule, but real-time pool events (new swaps, liquidity changes, oracle updates) via a push channel would make agents significantly more responsive.
- **Batch quote endpoint.** We probe multiple pools through the Trade API to compare routing quality. Each one is a separate HTTP call. A batch endpoint that accepts multiple token pairs and returns quotes for all of them would reduce latency and rate limit pressure.
- **Testnet-specific pool registry.** A simple API or list of "known active pools on Sepolia with sufficient liquidity and oracle history for development" would have saved us hours of pool hunting.

## Overall

Uniswap is genuinely the best DeFi protocol to build on for this kind of project. The fact that every v3 pool has a built-in TWAP oracle meant we could build a fully on-chain settlement layer without any external dependencies, and that's a unique property we haven't seen in other AMMs. The SDK ecosystem is strong, the Trade API is more versatile than its docs suggest, and the contract interfaces are clean. The friction is mostly at the edges: docs completeness, testnet DX, and the v3-to-v4 transition period where two SDKs coexist without clear guidance on when to use which.