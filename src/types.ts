import type { Address } from "viem";

export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface Env {
  AI: AiBinding;
  AGENT_STATE: KVNamespace;
  SEPOLIA_RPC_URL: string;
  SEPOLIA_PRIVATE_KEY: string;
  PREDICTION_MARKET_ADDRESS: string;
  UNISWAP_V3_FACTORY?: string;
  RUN_AUTH_HEADER?: string;
  SEPOLIA_CHAIN_ID?: string;

  POOL_SCAN_BLOCK_LOOKBACK?: string;
  SWAP_ACTIVITY_LOOKBACK_BLOCKS?: string;
  MAX_CANDIDATE_POOLS?: string;
  EVALUATION_POOL_LIMIT?: string;
  MIN_LIQUIDITY?: string;
}

export type Direction = "UP" | "DOWN";

export interface RuntimeConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  marketAddress: Address;
  factoryAddress: Address;
  chainId: number;
  runAuthHeader: string | undefined;

  poolScanBlockLookback: bigint;
  swapActivityLookbackBlocks: bigint;
  maxCandidatePools: number;
  evaluationPoolLimit: number;
  minLiquidity: bigint;
}

export interface PoolCache {
  lastScannedBlock: string;
  pools: Address[];
}

export interface RoundState {
  activeRoundId?: string | undefined;
  activePool?: Address | undefined;
  activePair?: string | undefined;
  activeStatement?: string | undefined;
  activeDirection?: Direction | undefined;
  activeDurationSeconds?: number | undefined;
  activeTwapWindowSeconds?: number | undefined;
  activeStartTimestamp?: number | undefined;
  activeEndTimestamp?: number | undefined;
}

export interface PoolSnapshot {
  pool: Address;
  token0: Address;
  token1: Address;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  liquidity: bigint;
  currentTick: number;
  shortTwapTick: number;
  longTwapTick: number;
  observationCardinality: number;
  swapCountRecent: number;
}

export interface PoolScore {
  pool: PoolSnapshot;
  stabilityScore: number;
  manipulationScore: number;
  profitabilityScore: number;
  signalScore: number;
  totalScore: number;
  diagnostics: string[];
}

export interface RoundPlan {
  pool: Address;
  pair: string;
  direction: Direction;
  durationSeconds: number;
  twapWindowSeconds: number;
  confidence: number;
  statement: string;
}

export interface AnalysisRecord {
  timestampIso: string;
  blockNumber: string;
  selected: {
    pool: Address;
    pair: string;
    direction: Direction;
    totalScore: number;
    confidence: number;
    durationSeconds: number;
    twapWindowSeconds: number;
    statement: string;
    diagnostics: string[];
  };
  topPools: Array<{
    pool: Address;
    pair: string;
    totalScore: number;
    stabilityScore: number;
    manipulationScore: number;
    profitabilityScore: number;
    signalScore: number;
  }>;
}

export interface EndedRoundRecord {
  roundId: string;
  pool: Address;
  pair: string;
  statement: string;
  startedAt: number;
  endedAt: number;
  resolvedAt: number;
  outcome: "YES" | "NO" | "VOID";
  txHash: `0x${string}`;
}

export interface PlatformStats {
  totalAgentRuns: number;
  totalRoundsCreatedByAgent: number;
  totalRoundsResolvedByAgent: number;
  latestRunAt?: string;
  lastError?: string;
}

export interface AgentRunResult {
  createdRoundId?: string;
  resolvedRoundId?: string;
  analysis?: AnalysisRecord;
}
