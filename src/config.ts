import { getAddress, isAddress } from "viem";
import type { Address } from "viem";

import type { Env, RuntimeConfig } from "./types";

const DEFAULT_FACTORY = "0x0227628f3F023bb0B980b67D528571c95c6DaC1c";
const DEFAULT_UNISWAP_TRADE_API_BASE = "https://trade-api.gateway.uniswap.org";
const DEFAULT_UNISWAP_AI_CONTEXT_URL = "https://developers.uniswap.org/docs/uniswap-ai/llms.txt";

function requireString(value: string | undefined, key: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required configuration: ${key}`);
  }
  return value.trim();
}

function parseAddress(value: string | undefined, key: string): Address {
  const raw = requireString(value, key);
  if (!isAddress(raw)) {
    throw new Error(`Invalid address in ${key}: ${raw}`);
  }
  return getAddress(raw);
}

function parsePrivateKey(value: string | undefined): `0x${string}` {
  const raw = requireString(value, "SEPOLIA_PRIVATE_KEY").trim();
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("SEPOLIA_PRIVATE_KEY must be a 32-byte hex string");
  }
  return normalized as `0x${string}`;
}

function parseIntFromEnv(
  value: string | undefined,
  fallback: number,
  key: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseBigIntFromEnv(
  value: string | undefined,
  fallback: bigint,
  key: string,
  min: bigint,
): bigint {
  if (!value || value.trim().length === 0) {
    return fallback;
  }

  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${key} must be a valid integer string`);
  }

  if (parsed < min) {
    throw new Error(`${key} must be >= ${min.toString()}`);
  }

  return parsed;
}

export function loadConfig(env: Env): RuntimeConfig {
  const chainId = parseIntFromEnv(env.SEPOLIA_CHAIN_ID, 11155111, "SEPOLIA_CHAIN_ID");

  return {
    rpcUrl: requireString(env.SEPOLIA_RPC_URL, "SEPOLIA_RPC_URL"),
    privateKey: parsePrivateKey(env.SEPOLIA_PRIVATE_KEY),
    marketAddress: parseAddress(env.PREDICTION_MARKET_ADDRESS, "PREDICTION_MARKET_ADDRESS"),
    factoryAddress: parseAddress(env.UNISWAP_V3_FACTORY ?? DEFAULT_FACTORY, "UNISWAP_V3_FACTORY"),
    chainId,
    runAuthHeader: env.RUN_AUTH_HEADER && env.RUN_AUTH_HEADER.trim().length > 0 ? env.RUN_AUTH_HEADER.trim() : undefined,
    poolScanBlockLookback: parseBigIntFromEnv(env.POOL_SCAN_BLOCK_LOOKBACK, 35_000n, "POOL_SCAN_BLOCK_LOOKBACK", 100n),
    swapActivityLookbackBlocks: parseBigIntFromEnv(
      env.SWAP_ACTIVITY_LOOKBACK_BLOCKS,
      2_500n,
      "SWAP_ACTIVITY_LOOKBACK_BLOCKS",
      100n,
    ),
    maxCandidatePools: parseIntFromEnv(env.MAX_CANDIDATE_POOLS, 80, "MAX_CANDIDATE_POOLS", 10, 250),
    evaluationPoolLimit: parseIntFromEnv(env.EVALUATION_POOL_LIMIT, 16, "EVALUATION_POOL_LIMIT", 3, 50),
    minLiquidity: parseBigIntFromEnv(env.MIN_LIQUIDITY, 100_000n, "MIN_LIQUIDITY", 1n),
    uniswapApiKey: env.UNISWAP_API_KEY && env.UNISWAP_API_KEY.trim().length > 0 ? env.UNISWAP_API_KEY.trim() : undefined,
    uniswapTradeApiBase:
      env.UNISWAP_TRADE_API_BASE && env.UNISWAP_TRADE_API_BASE.trim().length > 0
        ? env.UNISWAP_TRADE_API_BASE.trim().replace(/\/+$/, "")
        : DEFAULT_UNISWAP_TRADE_API_BASE,
    uniswapV3SubgraphUrl:
      env.UNISWAP_V3_SUBGRAPH_URL && env.UNISWAP_V3_SUBGRAPH_URL.trim().length > 0
        ? env.UNISWAP_V3_SUBGRAPH_URL.trim()
        : undefined,
    uniswapV4SubgraphUrl:
      env.UNISWAP_V4_SUBGRAPH_URL && env.UNISWAP_V4_SUBGRAPH_URL.trim().length > 0
        ? env.UNISWAP_V4_SUBGRAPH_URL.trim()
        : undefined,
    uniswapAiContextUrl:
      env.UNISWAP_AI_CONTEXT_URL && env.UNISWAP_AI_CONTEXT_URL.trim().length > 0
        ? env.UNISWAP_AI_CONTEXT_URL.trim()
        : DEFAULT_UNISWAP_AI_CONTEXT_URL,
  };
}
