import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { buildRoundPlan, pickTopPools, scorePool } from "./analysis";
import { erc20MetadataAbi, predictionMarketAbi, uniswapV3FactoryAbi, uniswapV3PoolAbi } from "./abi";
import { loadConfig } from "./config";
import {
  fetchUniswapAiContextSnippet,
  fetchUniswapApiQuoteProbe,
  fetchV3SubgraphPoolCandidates,
  fetchV4SubgraphMarketSnapshot,
} from "./uniswap";
import type {
  AgentRunResult,
  AnalysisRecord,
  EndedRoundRecord,
  Env,
  PlatformStats,
  PoolCache,
  PoolScore,
  PoolSnapshot,
  RoundPlan,
  RoundState,
  RuntimeConfig,
  UniswapApiQuoteProbe,
  V4SubgraphMarketSnapshot,
} from "./types";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

const KV_KEYS = {
  state: "agent:round-state",
  analysis: "analysis:latest",
  recentRounds: "rounds:recent",
  stats: "agent:stats",
  pools: "agent:pools:v1",
  aiContext: "agent:uniswap-ai-context:v1",
} as const;

const MAX_RECENT_ROUNDS = 30;
const SHORT_TWAP_WINDOW = 90;
const LONG_TWAP_WINDOW = 300;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    },
  });
}

async function readJson<T>(kv: KVNamespace, key: string, fallback: T): Promise<T> {
  const raw = await kv.get(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(kv: KVNamespace, key: string, value: unknown): Promise<void> {
  await kv.put(key, JSON.stringify(value));
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function safeSymbol(symbol: string | undefined, fallback: Address): string {
  if (!symbol || symbol.trim().length === 0) {
    return `${fallback.slice(0, 6)}..${fallback.slice(-4)}`;
  }
  const cleaned = symbol.trim().replace(/[^A-Za-z0-9._-]/g, "");
  if (cleaned.length === 0) {
    return `${fallback.slice(0, 6)}..${fallback.slice(-4)}`;
  }
  return cleaned.slice(0, 16);
}

function computeMeanTick(tickCumulatives: bigint[], windowSeconds: number): number {
  const delta = tickCumulatives[1] - tickCumulatives[0];
  const window = BigInt(windowSeconds);

  let mean = delta / window;
  if (delta < 0n && delta % window !== 0n) {
    mean -= 1n;
  }

  return Number(mean);
}

function formatPair(token0: string, token1: string): string {
  return `${token0}/${token1}`;
}

function clampRound(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildQuoteProbeAmount(decimals: number): string {
  const safeDecimals = clampNumber(Math.trunc(decimals), 0, 18);
  // Keep probe sizes moderate on testnets to reduce "No quote" due oversized input.
  const probeDecimals = safeDecimals > 10 ? 10 : safeDecimals;
  const amount = 10n ** BigInt(probeDecimals);
  return amount.toString();
}

function getClients(config: RuntimeConfig) {
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl, { timeout: 20_000, retryCount: 2 });

  const publicClient = createPublicClient({
    chain: sepolia,
    transport,
    batch: {
      multicall: {
        wait: 20,
      },
    },
  });

  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport,
  });

  return { publicClient, walletClient, account };
}

async function getPoolUniverse(
  publicClient: ReturnType<typeof createPublicClient>,
  config: RuntimeConfig,
  kv: KVNamespace,
): Promise<{ pools: Address[]; blockNumber: bigint }> {
  const cached = await readJson<PoolCache | null>(kv, KV_KEYS.pools, null);
  const latestBlock = await publicClient.getBlockNumber();

  const fallbackFrom = latestBlock > config.poolScanBlockLookback ? latestBlock - config.poolScanBlockLookback : 0n;
  const fromBlock = (() => {
    if (!cached?.lastScannedBlock) {
      return fallbackFrom;
    }

    const cachedBlock = BigInt(cached.lastScannedBlock);
    if (cachedBlock >= latestBlock) {
      return latestBlock;
    }

    const next = cachedBlock + 1n;
    return next > fallbackFrom ? next : fallbackFrom;
  })();

  const poolSet = new Set<Address>(cached?.pools ?? []);

  if (config.uniswapV3SubgraphUrl) {
    try {
      const subgraphPools = await fetchV3SubgraphPoolCandidates(config.uniswapV3SubgraphUrl, config.maxCandidatePools);
      for (const pool of subgraphPools) {
        poolSet.add(pool.id);
      }
    } catch {
      // Continue with onchain discovery if subgraph endpoint is unavailable or mismatched.
    }
  }

  if (fromBlock <= latestBlock) {
    const logs = await publicClient.getLogs({
      address: config.factoryAddress,
      event: uniswapV3FactoryAbi[0],
      fromBlock,
      toBlock: latestBlock,
    });

    for (const log of logs) {
      const pool = (log as { args?: { pool?: Address } }).args?.pool;
      if (pool) {
        poolSet.add(getAddress(pool));
      }
    }
  }

  const pools = [...poolSet].slice(-config.maxCandidatePools);

  await writeJson(kv, KV_KEYS.pools, {
    lastScannedBlock: latestBlock.toString(),
    pools,
  } satisfies PoolCache);

  return { pools, blockNumber: latestBlock };
}

async function fetchTokenMetadata(
  publicClient: ReturnType<typeof createPublicClient>,
  tokenAddresses: Address[],
): Promise<{ symbols: Map<Address, string>; decimals: Map<Address, number> }> {
  const symbols = new Map<Address, string>();
  const decimals = new Map<Address, number>();

  if (tokenAddresses.length === 0) {
    return { symbols, decimals };
  }

  const symbolCalls = tokenAddresses.map((token) => ({
    address: token,
    abi: erc20MetadataAbi,
    functionName: "symbol" as const,
  }));

  const symbolResults = await publicClient.multicall({
    contracts: symbolCalls,
    allowFailure: true,
  });

  const decimalCalls = tokenAddresses.map((token) => ({
    address: token,
    abi: erc20MetadataAbi,
    functionName: "decimals" as const,
  }));

  const decimalResults = await publicClient.multicall({
    contracts: decimalCalls,
    allowFailure: true,
  });

  for (let i = 0; i < tokenAddresses.length; i += 1) {
    const token = tokenAddresses[i];
    const symbolResult = symbolResults[i];
    const decimalResult = decimalResults[i];

    const symbol =
      symbolResult.status === "success" && typeof symbolResult.result === "string" ? symbolResult.result : undefined;
    const tokenDecimals =
      decimalResult.status === "success" && typeof decimalResult.result === "number" ? decimalResult.result : 18;

    symbols.set(token, safeSymbol(symbol, token));
    decimals.set(token, tokenDecimals);
  }

  return { symbols, decimals };
}

async function fetchSwapActivity(
  publicClient: ReturnType<typeof createPublicClient>,
  pools: Address[],
  latestBlock: bigint,
  lookback: bigint,
): Promise<Map<Address, number>> {
  const fromBlock = latestBlock > lookback ? latestBlock - lookback : 0n;
  const swapCounts = new Map<Address, number>();

  await Promise.all(
    pools.map(async (pool) => {
      try {
        const logs = await publicClient.getLogs({
          address: pool,
          event: uniswapV3PoolAbi[6],
          fromBlock,
          toBlock: latestBlock,
        });
        swapCounts.set(pool, logs.length);
      } catch {
        swapCounts.set(pool, 0);
      }
    }),
  );

  return swapCounts;
}

async function fetchPoolSnapshots(
  publicClient: ReturnType<typeof createPublicClient>,
  config: RuntimeConfig,
  marketAddress: Address,
  pools: Address[],
  latestBlock: bigint,
): Promise<PoolSnapshot[]> {
  const limitedPools = pools.slice(-config.evaluationPoolLimit);
  if (limitedPools.length === 0) {
    return [];
  }

  const contracts = limitedPools.flatMap((pool) => [
    { address: pool, abi: uniswapV3PoolAbi, functionName: "token0" as const },
    { address: pool, abi: uniswapV3PoolAbi, functionName: "token1" as const },
    { address: pool, abi: uniswapV3PoolAbi, functionName: "fee" as const },
    { address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" as const },
    { address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" as const },
    {
      address: pool,
      abi: uniswapV3PoolAbi,
      functionName: "observe" as const,
      args: [[SHORT_TWAP_WINDOW, 0]] as const,
    },
    {
      address: pool,
      abi: uniswapV3PoolAbi,
      functionName: "observe" as const,
      args: [[LONG_TWAP_WINDOW, 0]] as const,
    },
  ]);

  const raw = await publicClient.multicall({ contracts, allowFailure: true });

  const tokenAddresses = new Set<Address>();
  const rows: Array<{
    pool: Address;
    token0: Address;
    token1: Address;
    fee: number;
    liquidity: bigint;
    currentTick: number;
    observationCardinality: number;
    shortTwapTick: number;
    longTwapTick: number;
  }> = [];

  for (let i = 0; i < limitedPools.length; i += 1) {
    const offset = i * 7;

    const token0Call = raw[offset];
    const token1Call = raw[offset + 1];
    const feeCall = raw[offset + 2];
    const liquidityCall = raw[offset + 3];
    const slot0Call = raw[offset + 4];
    const shortObsCall = raw[offset + 5];
    const longObsCall = raw[offset + 6];

    if (
      token0Call.status !== "success" ||
      token1Call.status !== "success" ||
      feeCall.status !== "success" ||
      liquidityCall.status !== "success" ||
      slot0Call.status !== "success" ||
      shortObsCall.status !== "success" ||
      longObsCall.status !== "success"
    ) {
      continue;
    }

    const token0 = getAddress(token0Call.result as Address);
    const token1 = getAddress(token1Call.result as Address);
    const fee = Number(feeCall.result);
    const liquidity = liquidityCall.result as bigint;

    if (liquidity < config.minLiquidity) {
      continue;
    }

    const slot0 = slot0Call.result as readonly [bigint, number, number, number, number, number, boolean];
    const shortObs = shortObsCall.result as readonly [bigint[], bigint[]];
    const longObs = longObsCall.result as readonly [bigint[], bigint[]];

    if (shortObs[0].length < 2 || longObs[0].length < 2) {
      continue;
    }

    const shortTwapTick = computeMeanTick(shortObs[0], SHORT_TWAP_WINDOW);
    const longTwapTick = computeMeanTick(longObs[0], LONG_TWAP_WINDOW);

    rows.push({
      pool: limitedPools[i],
      token0,
      token1,
      fee,
      liquidity,
      currentTick: Number(slot0[1]),
      observationCardinality: Number(slot0[3]),
      shortTwapTick,
      longTwapTick,
    });

    tokenAddresses.add(token0);
    tokenAddresses.add(token1);
  }

  if (rows.length === 0) {
    return [];
  }

  const [{ symbols: symbolMap, decimals: decimalMap }, swapActivityMap] = await Promise.all([
    fetchTokenMetadata(publicClient, [...tokenAddresses]),
    fetchSwapActivity(publicClient, rows.map((row) => row.pool), latestBlock, config.swapActivityLookbackBlocks),
  ]);

  // Filter pools that currently already have an unresolved round in the prediction market.
  const activeRoundCalls = await publicClient.multicall({
    contracts: rows.map((row) => ({
      address: marketAddress,
      abi: predictionMarketAbi,
      functionName: "activeRoundForPool" as const,
      args: [row.pool] as const,
    })),
    allowFailure: true,
  });

  const snapshots: PoolSnapshot[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const activeRound = activeRoundCalls[i];
    if (activeRound.status === "success" && activeRound.result > 0n) {
      continue;
    }

    const row = rows[i];
    const token0Symbol = symbolMap.get(row.token0) ?? safeSymbol(undefined, row.token0);
    const token1Symbol = symbolMap.get(row.token1) ?? safeSymbol(undefined, row.token1);
    const token0Decimals = decimalMap.get(row.token0) ?? 18;
    const token1Decimals = decimalMap.get(row.token1) ?? 18;

    snapshots.push({
      pool: row.pool,
      token0: row.token0,
      token1: row.token1,
      token0Symbol,
      token1Symbol,
      token0Decimals,
      token1Decimals,
      fee: row.fee,
      liquidity: row.liquidity,
      currentTick: row.currentTick,
      shortTwapTick: row.shortTwapTick,
      longTwapTick: row.longTwapTick,
      observationCardinality: row.observationCardinality,
      swapCountRecent: swapActivityMap.get(row.pool) ?? 0,
    });
  }

  return snapshots;
}

async function getCachedUniswapAiContext(kv: KVNamespace, config: RuntimeConfig): Promise<string | null> {
  type Cache = { fetchedAt: string; snippet: string };
  const cached = await readJson<Cache | null>(kv, KV_KEYS.aiContext, null);
  const now = Date.now();

  if (cached?.snippet && cached.snippet.trim().length > 0) {
    const fetchedAt = Number.parseInt(cached.fetchedAt, 10);
    if (Number.isFinite(fetchedAt) && now - fetchedAt < 24 * 60 * 60 * 1000) {
      return cached.snippet;
    }
  }

  const snippet = await fetchUniswapAiContextSnippet(config.uniswapAiContextUrl, 1400);
  if (!snippet) {
    return cached?.snippet ?? null;
  }

  await writeJson(kv, KV_KEYS.aiContext, {
    fetchedAt: String(now),
    snippet,
  } satisfies Cache);

  return snippet;
}

async function generateLlamaStatement(
  env: Env,
  aiContextSnippet: string | null,
  plan: RoundPlan,
  score: PoolScore,
): Promise<string> {
  try {
    const prompt = {
      messages: [
        {
          role: "system",
          content:
            "You are a prediction-market analyst. Return one concise statement only, no markdown, no explanation. Keep it under 140 characters.",
        },
        {
          role: "user",
          content: [
            aiContextSnippet
              ? `Uniswap context excerpt (for terminology consistency only): ${aiContextSnippet}`
              : "Use standard Uniswap terminology.",
            `Pair: ${plan.pair}`,
            `Direction: ${plan.direction}`,
            `Duration minutes: ${Math.round(plan.durationSeconds / 60)}`,
            `Confidence: ${clampRound(plan.confidence)}`,
            `Drift ticks: ${score.pool.shortTwapTick - score.pool.longTwapTick}`,
            "Output format: '<PAIR> will <increase|decrease> in the next <N> minutes.'",
          ].join("\n"),
        },
      ],
      max_tokens: 80,
      temperature: 0.2,
    };

    const raw = await env.AI.run(MODEL, prompt);
    const responseText =
      typeof raw === "object" && raw !== null && "response" in raw && typeof (raw as { response?: unknown }).response === "string"
        ? (raw as { response: string }).response
        : undefined;

    if (!responseText) {
      return plan.statement;
    }

    const condensed = responseText.replace(/\s+/g, " ").trim();
    if (condensed.length < 20 || condensed.length > 180) {
      return plan.statement;
    }

    return condensed;
  } catch {
    return plan.statement;
  }
}

async function resolveActiveRoundIfReady(
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  config: RuntimeConfig,
  state: RoundState,
): Promise<EndedRoundRecord | null> {
  if (!state.activeRoundId) {
    return null;
  }

  const roundId = BigInt(state.activeRoundId);
  let round: any;

  try {
    round = await publicClient.readContract({
      address: config.marketAddress,
      abi: predictionMarketAbi,
      functionName: "getRound",
      args: [roundId],
    });
  } catch {
    return null;
  }

  if (round.resolved) {
    return {
      roundId: roundId.toString(),
      pool: getAddress(round.pool),
      pair: state.activePair ?? "unknown/unknown",
      statement: state.activeStatement ?? round.statement ?? "",
      startedAt: Number(round.startTimestamp),
      endedAt: Number(round.endTimestamp),
      resolvedAt: nowUnix(),
      outcome: round.voided ? "VOID" : round.outcomeYes ? "YES" : "NO",
      txHash: "0x0" as Hex,
    };
  }

  if (BigInt(nowUnix()) < BigInt(round.endTimestamp)) {
    return null;
  }

  const txHash = await walletClient.writeContract({
    address: config.marketAddress,
    abi: predictionMarketAbi,
    functionName: "resolveRound",
    args: [roundId],
    account,
    chain: sepolia,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });

  const resolvedLogs = parseEventLogs({
    abi: predictionMarketAbi,
    logs: receipt.logs,
    eventName: "RoundResolved",
    strict: false,
  });

  const resolvedArgs = resolvedLogs[0]?.args;
  const voided = Boolean(resolvedArgs?.voided ?? round.voided);
  const outcomeYes = Boolean(resolvedArgs?.outcomeYes ?? round.outcomeYes);

  return {
    roundId: roundId.toString(),
    pool: getAddress(round.pool),
    pair: state.activePair ?? "unknown/unknown",
    statement: state.activeStatement ?? round.statement ?? "",
    startedAt: Number(round.startTimestamp),
    endedAt: Number(round.endTimestamp),
    resolvedAt: nowUnix(),
    outcome: voided ? "VOID" : outcomeYes ? "YES" : "NO",
    txHash,
  };
}

async function buildAnalysis(
  publicClient: ReturnType<typeof createPublicClient>,
  config: RuntimeConfig,
  kv: KVNamespace,
): Promise<{ analysis: AnalysisRecord; topScored: PoolScore[]; selectedScore: PoolScore }> {
  const { pools, blockNumber } = await getPoolUniverse(publicClient, config, kv);

  if (pools.length === 0) {
    throw new Error("No candidate pools discovered from Uniswap v3 factory logs");
  }

  const snapshots = await fetchPoolSnapshots(publicClient, config, config.marketAddress, pools, blockNumber);
  if (snapshots.length === 0) {
    throw new Error("No analyzable pools met the minimum thresholds");
  }

  const scored = snapshots.map(scorePool);
  const topScored = pickTopPools(scored, 5);
  const selectedScore = topScored[0];
  const selectedPlan = buildRoundPlan(selectedScore);

  const analysis: AnalysisRecord = {
    timestampIso: new Date().toISOString(),
    blockNumber: blockNumber.toString(),
    selected: {
      pool: selectedPlan.pool,
      pair: selectedPlan.pair,
      direction: selectedPlan.direction,
      totalScore: clampRound(selectedScore.totalScore),
      confidence: clampRound(selectedPlan.confidence),
      durationSeconds: selectedPlan.durationSeconds,
      twapWindowSeconds: selectedPlan.twapWindowSeconds,
      statement: selectedPlan.statement,
      diagnostics: selectedScore.diagnostics,
    },
    topPools: topScored.map((entry) => ({
      pool: entry.pool.pool,
      pair: formatPair(entry.pool.token0Symbol, entry.pool.token1Symbol),
      totalScore: clampRound(entry.totalScore),
      stabilityScore: clampRound(entry.stabilityScore),
      manipulationScore: clampRound(entry.manipulationScore),
      profitabilityScore: clampRound(entry.profitabilityScore),
      signalScore: clampRound(entry.signalScore),
    })),
  };

  return { analysis, topScored, selectedScore };
}

async function runAgent(env: Env, trigger: "scheduled" | "manual"): Promise<AgentRunResult> {
  const config = loadConfig(env);
  const { publicClient, walletClient, account } = getClients(config);

  const state = await readJson<RoundState>(env.AGENT_STATE, KV_KEYS.state, {});
  const stats = await readJson<PlatformStats>(env.AGENT_STATE, KV_KEYS.stats, {
    totalAgentRuns: 0,
    totalRoundsCreatedByAgent: 0,
    totalRoundsResolvedByAgent: 0,
  });

  stats.totalAgentRuns += 1;
  stats.latestRunAt = new Date().toISOString();
  delete stats.lastError;

  const runResult: AgentRunResult = {};

  try {
    const endedRound = await resolveActiveRoundIfReady(publicClient, walletClient, account, config, state);
    if (endedRound) {
      if (endedRound.txHash !== ("0x0" as Hex)) {
        stats.totalRoundsResolvedByAgent += 1;
      }

      runResult.resolvedRoundId = endedRound.roundId;

      const recentRounds = await readJson<EndedRoundRecord[]>(env.AGENT_STATE, KV_KEYS.recentRounds, []);
      const merged = [endedRound, ...recentRounds].slice(0, MAX_RECENT_ROUNDS);
      await writeJson(env.AGENT_STATE, KV_KEYS.recentRounds, merged);

      state.activeRoundId = undefined;
      state.activePool = undefined;
      state.activePair = undefined;
      state.activeStatement = undefined;
      state.activeDirection = undefined;
      state.activeDurationSeconds = undefined;
      state.activeTwapWindowSeconds = undefined;
      state.activeStartTimestamp = undefined;
      state.activeEndTimestamp = undefined;
    }

    if (!state.activeRoundId) {
      const { analysis, selectedScore } = await buildAnalysis(publicClient, config, env.AGENT_STATE);
      const plan = buildRoundPlan(selectedScore);

      const [quoteProbe, v4MarketSnapshot, aiContextSnippet] = await Promise.all([
        fetchUniswapApiQuoteProbe({
          config,
          swapper: account.address,
          tokenIn: selectedScore.pool.token0,
          tokenOut: selectedScore.pool.token1,
          amount: buildQuoteProbeAmount(selectedScore.pool.token0Decimals),
        }).catch(() => null),
        config.uniswapV4SubgraphUrl
          ? fetchV4SubgraphMarketSnapshot(config.uniswapV4SubgraphUrl).catch(() => null)
          : Promise.resolve<V4SubgraphMarketSnapshot | null>(null),
        getCachedUniswapAiContext(env.AGENT_STATE, config).catch(() => null),
      ]);

      if (quoteProbe?.priceImpact !== undefined) {
        if (quoteProbe.priceImpact >= 2) {
          plan.confidence = clampNumber(plan.confidence - 0.18, 0, 1);
          plan.durationSeconds = Math.trunc(clampNumber(plan.durationSeconds + 120, 300, 900));
          plan.twapWindowSeconds = Math.trunc(clampNumber(plan.twapWindowSeconds + 45, 30, Math.min(300, plan.durationSeconds - 30)));
        } else if (quoteProbe.includesV4 && quoteProbe.priceImpact <= 0.8) {
          plan.confidence = clampNumber(plan.confidence + 0.06, 0, 1);
          plan.durationSeconds = Math.trunc(clampNumber(plan.durationSeconds - 60, 300, 900));
          plan.twapWindowSeconds = Math.trunc(clampNumber(plan.twapWindowSeconds - 30, 30, Math.min(300, plan.durationSeconds - 30)));
        }
      }

      if (quoteProbe?.v4PoolIdValidated === false) {
        plan.confidence = clampNumber(plan.confidence - 0.1, 0, 1);
        plan.durationSeconds = Math.trunc(clampNumber(plan.durationSeconds + 60, 300, 900));
      }

      plan.statement = await generateLlamaStatement(env, aiContextSnippet, plan, selectedScore);

      analysis.selected.statement = plan.statement;
      analysis.selected.confidence = clampRound(plan.confidence);
      analysis.selected.durationSeconds = plan.durationSeconds;
      analysis.selected.twapWindowSeconds = plan.twapWindowSeconds;
      analysis.integrations = {
        used: [
          "uniswap-v3-onchain-rpc",
          "uniswap-v3-sdk",
          ...(config.uniswapV3SubgraphUrl ? ["uniswap-v3-subgraph"] : []),
          ...(quoteProbe ? ["uniswap-trade-api"] : []),
          ...(quoteProbe?.includesV4 ? ["uniswap-v4-routing"] : []),
          ...(quoteProbe?.v4PoolIdValidated ? ["uniswap-v4-sdk-poolid-validation"] : []),
          ...(v4MarketSnapshot ? ["uniswap-v4-subgraph"] : []),
          ...(aiContextSnippet ? ["uniswap-ai-context"] : []),
        ],
        ...(quoteProbe ? { uniswapApiQuote: quoteProbe } : {}),
        ...(v4MarketSnapshot ? { v4Market: v4MarketSnapshot } : {}),
      };

      const txHash = await walletClient.writeContract({
        address: config.marketAddress,
        abi: predictionMarketAbi,
        functionName: "createRound",
        args: [plan.pool, plan.durationSeconds, plan.twapWindowSeconds, plan.statement],
        account,
        chain: sepolia,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
      const createdLogs = parseEventLogs({
        abi: predictionMarketAbi,
        logs: receipt.logs,
        eventName: "RoundCreated",
        strict: false,
      });

      const created = createdLogs[0]?.args;
      const roundId = created?.roundId ? created.roundId.toString() : undefined;

      if (!roundId) {
        throw new Error("createRound transaction mined but RoundCreated event was not found");
      }

      state.activeRoundId = roundId;
      state.activePool = plan.pool;
      state.activePair = plan.pair;
      state.activeStatement = plan.statement;
      state.activeDirection = plan.direction;
      state.activeDurationSeconds = plan.durationSeconds;
      state.activeTwapWindowSeconds = plan.twapWindowSeconds;
      state.activeStartTimestamp = Number(created?.startTimestamp ?? nowUnix());
      state.activeEndTimestamp = Number(created?.endTimestamp ?? nowUnix() + plan.durationSeconds);

      stats.totalRoundsCreatedByAgent += 1;

      runResult.createdRoundId = roundId;
      runResult.analysis = analysis;

      await writeJson(env.AGENT_STATE, KV_KEYS.analysis, analysis);
    }

    await writeJson(env.AGENT_STATE, KV_KEYS.state, state);
    await writeJson(env.AGENT_STATE, KV_KEYS.stats, stats);

    return runResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.lastError = `[${trigger}] ${message}`;
    await writeJson(env.AGENT_STATE, KV_KEYS.stats, stats);
    throw error;
  }
}

async function getOnchainStats(publicClient: ReturnType<typeof createPublicClient>, marketAddress: Address) {
  const values = await publicClient.multicall({
    contracts: [
      { address: marketAddress, abi: predictionMarketAbi, functionName: "totalRoundsCreated" as const },
      { address: marketAddress, abi: predictionMarketAbi, functionName: "totalRoundsResolved" as const },
      { address: marketAddress, abi: predictionMarketAbi, functionName: "totalVolume" as const },
      { address: marketAddress, abi: predictionMarketAbi, functionName: "totalUniqueParticipants" as const },
    ],
    allowFailure: true,
  });

  return {
    totalRoundsCreated: values[0].status === "success" ? values[0].result.toString() : null,
    totalRoundsResolved: values[1].status === "success" ? values[1].result.toString() : null,
    totalVolumeWei: values[2].status === "success" ? values[2].result.toString() : null,
    totalUniqueParticipants: values[3].status === "success" ? values[3].result.toString() : null,
  };
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") {
    return jsonResponse({ ok: true });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/" || path === "/health") {
    const state = await readJson<RoundState>(env.AGENT_STATE, KV_KEYS.state, {});
    const stats = await readJson<PlatformStats>(env.AGENT_STATE, KV_KEYS.stats, {
      totalAgentRuns: 0,
      totalRoundsCreatedByAgent: 0,
      totalRoundsResolvedByAgent: 0,
    });

    return jsonResponse({
      ok: true,
      service: "intracloud-agent",
      timestamp: new Date().toISOString(),
      activeRound: state.activeRoundId
        ? {
            roundId: state.activeRoundId,
            pair: state.activePair,
            pool: state.activePool,
            endTimestamp: state.activeEndTimestamp,
          }
        : null,
      stats,
    });
  }

  if (path === "/analysis/latest") {
    const analysis = await readJson<AnalysisRecord | null>(env.AGENT_STATE, KV_KEYS.analysis, null);
    return jsonResponse({ analysis });
  }

  if (path === "/rounds/recent") {
    const rounds = await readJson<EndedRoundRecord[]>(env.AGENT_STATE, KV_KEYS.recentRounds, []);
    return jsonResponse({ rounds });
  }

  if (path === "/stats") {
    const config = loadConfig(env);
    const { publicClient } = getClients(config);
    const [stats, onchain] = await Promise.all([
      readJson<PlatformStats>(env.AGENT_STATE, KV_KEYS.stats, {
        totalAgentRuns: 0,
        totalRoundsCreatedByAgent: 0,
        totalRoundsResolvedByAgent: 0,
      }),
      getOnchainStats(publicClient, config.marketAddress),
    ]);

    return jsonResponse({ stats, onchain });
  }

  if (path === "/run" && request.method === "POST") {
    const config = loadConfig(env);

    if (config.runAuthHeader) {
      const authHeader = request.headers.get("authorization") ?? "";
      if (authHeader !== config.runAuthHeader) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }
    }

    try {
      const result = await runAgent(env, "manual");
      return jsonResponse({ ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ ok: false, error: message }, 500);
    }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return jsonResponse({ ok: false, error: message }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runAgent(env, "scheduled").catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const stats = await readJson<PlatformStats>(env.AGENT_STATE, KV_KEYS.stats, {
          totalAgentRuns: 0,
          totalRoundsCreatedByAgent: 0,
          totalRoundsResolvedByAgent: 0,
        });
        stats.lastError = `[scheduled] ${message}`;
        await writeJson(env.AGENT_STATE, KV_KEYS.stats, stats);
      }),
    );
  },
};
