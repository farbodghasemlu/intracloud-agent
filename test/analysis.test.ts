import { describe, expect, it } from "vitest";

import { buildRoundPlan, scorePool } from "../src/analysis";
import type { PoolSnapshot } from "../src/types";

function makePool(overrides: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    pool: "0x0000000000000000000000000000000000000001",
    token0: "0x0000000000000000000000000000000000000011",
    token1: "0x0000000000000000000000000000000000000022",
    token0Symbol: "WETH",
    token1Symbol: "USDC",
    token0Decimals: 18,
    token1Decimals: 6,
    fee: 500,
    liquidity: 1_000_000_000_000n,
    currentTick: 120,
    shortTwapTick: 130,
    longTwapTick: 90,
    observationCardinality: 64,
    swapCountRecent: 24,
    ...overrides,
  };
}

describe("scorePool", () => {
  it("prefers stronger liquidity, oracle depth, and activity", () => {
    const strong = makePool();
    const weak = makePool({
      liquidity: 1_000n,
      observationCardinality: 2,
      swapCountRecent: 0,
      shortTwapTick: 10,
      longTwapTick: -150,
    });

    const strongScore = scorePool(strong);
    const weakScore = scorePool(weak);

    expect(strongScore.totalScore).toBeGreaterThan(weakScore.totalScore);
    expect(strongScore.manipulationScore).toBeGreaterThan(weakScore.manipulationScore);
  });
});

describe("buildRoundPlan", () => {
  it("produces contract-safe round parameters", () => {
    const score = scorePool(makePool());
    const plan = buildRoundPlan(score);

    expect(plan.durationSeconds).toBeGreaterThanOrEqual(300);
    expect(plan.durationSeconds).toBeLessThanOrEqual(900);

    expect(plan.twapWindowSeconds).toBeGreaterThanOrEqual(30);
    expect(plan.twapWindowSeconds).toBeLessThanOrEqual(300);
    expect(plan.twapWindowSeconds).toBeLessThanOrEqual(plan.durationSeconds);

    expect(plan.statement.length).toBeGreaterThan(10);
    expect(["UP", "DOWN"]).toContain(plan.direction);
  });
});
