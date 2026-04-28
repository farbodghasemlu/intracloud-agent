import { Token } from "@uniswap/sdk-core";
import { tickToPrice } from "@uniswap/v3-sdk";

import type { Direction, PoolScore, PoolSnapshot, RoundPlan } from "./types";

const FEE_SCORE: Record<number, number> = {
  100: 0.65,
  500: 0.92,
  3000: 0.86,
  10000: 0.55,
};

const CHAIN_ID = 11155111;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeNumber(value: string): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }
  return num;
}

function derivePriceDriftPct(pool: PoolSnapshot): number {
  try {
    const token0 = new Token(CHAIN_ID, pool.token0, pool.token0Decimals, pool.token0Symbol);
    const token1 = new Token(CHAIN_ID, pool.token1, pool.token1Decimals, pool.token1Symbol);

    const shortPrice = safeNumber(tickToPrice(token0, token1, pool.shortTwapTick).toSignificant(12));
    const longPrice = safeNumber(tickToPrice(token0, token1, pool.longTwapTick).toSignificant(12));
    if (shortPrice === null || longPrice === null || longPrice === 0) {
      return 0;
    }

    return ((shortPrice - longPrice) / longPrice) * 100;
  } catch {
    return 0;
  }
}

function scoreLiquidity(liquidity: bigint): number {
  // Log scaling keeps huge values from dominating while preserving rank order.
  const liquidityFloat = Number(liquidity > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : liquidity);
  const normalized = Math.log10(liquidityFloat + 1) / 12;
  return clamp(normalized, 0, 1);
}

function scoreStability(shortTick: number, longTick: number): number {
  const drift = Math.abs(shortTick - longTick);
  const driftPenalty = clamp(drift / 260, 0, 1);
  return 1 - driftPenalty;
}

function scoreSignal(currentTick: number, shortTick: number, longTick: number): number {
  const trend = shortTick - longTick;
  const momentum = shortTick - currentTick;

  const trendStrength = clamp(Math.abs(trend) / 120, 0, 1);
  const momentumStrength = clamp(Math.abs(momentum) / 80, 0, 1);

  return clamp(0.65 * trendStrength + 0.35 * momentumStrength, 0, 1);
}

function scoreOracleDepth(observationCardinality: number): number {
  return clamp(observationCardinality / 48, 0, 1);
}

function scoreActivity(swapCountRecent: number): number {
  return clamp(swapCountRecent / 40, 0, 1);
}

export function scorePool(pool: PoolSnapshot): PoolScore {
  const sdkPriceDriftPct = derivePriceDriftPct(pool);
  const liquidityScore = scoreLiquidity(pool.liquidity);
  const stability = scoreStability(pool.shortTwapTick, pool.longTwapTick);
  const oracleDepth = scoreOracleDepth(pool.observationCardinality);
  const activity = scoreActivity(pool.swapCountRecent);
  const feeScore = FEE_SCORE[pool.fee] ?? 0.5;
  const signal = scoreSignal(pool.currentTick, pool.shortTwapTick, pool.longTwapTick);
  const sdkDriftSignal = clamp(Math.abs(sdkPriceDriftPct) / 4, 0, 1);

  const stabilityScore = clamp(0.7 * stability + 0.3 * liquidityScore, 0, 1);
  const manipulationScore = clamp(0.6 * liquidityScore + 0.4 * oracleDepth, 0, 1);
  const profitabilityScore = clamp(0.7 * activity + 0.3 * feeScore, 0, 1);

  const totalScore = clamp(
    0.43 * stabilityScore + 0.3 * manipulationScore + 0.15 * profitabilityScore + 0.07 * signal + 0.05 * sdkDriftSignal,
    0,
    1,
  );

  const diagnostics = [
    `liquidity=${round2(liquidityScore)}`,
    `stability=${round2(stabilityScore)}`,
    `manipulation=${round2(manipulationScore)}`,
    `profitability=${round2(profitabilityScore)}`,
    `signal=${round2(signal)}`,
    `sdkPriceDriftPct=${round2(sdkPriceDriftPct)}`,
    `driftTicks=${pool.shortTwapTick - pool.longTwapTick}`,
    `swapsRecent=${pool.swapCountRecent}`,
  ];

  return {
    pool,
    stabilityScore,
    manipulationScore,
    profitabilityScore,
    signalScore: signal,
    totalScore,
    diagnostics,
  };
}

export function pickTopPools(scoredPools: PoolScore[], count = 5): PoolScore[] {
  return [...scoredPools].sort((a, b) => b.totalScore - a.totalScore).slice(0, count);
}

function chooseDirection(score: PoolScore): Direction {
  const trend = score.pool.shortTwapTick - score.pool.longTwapTick;
  if (trend > 0) {
    return "UP";
  }
  if (trend < 0) {
    return "DOWN";
  }

  // If trend is flat, fallback to recent momentum.
  return score.pool.currentTick <= score.pool.shortTwapTick ? "UP" : "DOWN";
}

function chooseDurationSeconds(score: PoolScore): number {
  const base = 10 * 60;
  const confidenceImpact = Math.round((1 - score.totalScore) * 4) * 60;
  const activityBonus = score.pool.swapCountRecent >= 20 ? -120 : score.pool.swapCountRecent >= 10 ? -60 : 0;

  const duration = base + confidenceImpact + activityBonus;
  return clamp(duration, 5 * 60, 15 * 60);
}

function chooseTwapWindowSeconds(durationSeconds: number, score: PoolScore): number {
  const ratio = score.manipulationScore >= 0.75 ? 0.6 : score.manipulationScore >= 0.55 ? 0.5 : 0.4;
  const raw = Math.round(durationSeconds * ratio);
  const maxForDuration = Math.min(300, durationSeconds - 30);
  const bounded = clamp(raw, 30, maxForDuration);
  return Math.trunc(bounded);
}

function buildFallbackStatement(pair: string, direction: Direction, minutes: number): string {
  const directionText = direction === "UP" ? "increase" : "decrease";
  return `${pair} price will ${directionText} over the next ${minutes} minutes.`;
}

export function buildRoundPlan(score: PoolScore): RoundPlan {
  const pair = `${score.pool.token0Symbol}/${score.pool.token1Symbol}`;
  const direction = chooseDirection(score);
  const durationSeconds = chooseDurationSeconds(score);
  const twapWindowSeconds = chooseTwapWindowSeconds(durationSeconds, score);

  const confidence = clamp(
    0.5 * score.totalScore + 0.3 * score.manipulationScore + 0.2 * score.signalScore,
    0,
    1,
  );

  return {
    pool: score.pool.pool,
    pair,
    direction,
    durationSeconds,
    twapWindowSeconds,
    confidence,
    statement: buildFallbackStatement(pair, direction, Math.round(durationSeconds / 60)),
  };
}
