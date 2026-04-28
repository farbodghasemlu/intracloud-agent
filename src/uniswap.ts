import { getAddress, isAddress, type Address } from "viem";
import { Ether, Token, type Currency } from "@uniswap/sdk-core";
import { Pool as V4Pool } from "@uniswap/v4-sdk";

import type {
  RuntimeConfig,
  UniswapApiQuoteProbe,
  V3SubgraphPoolCandidate,
  V4SubgraphMarketSnapshot,
} from "./types";

const V4_POOL_MANAGER_ID = "0x000000000004444c5dc75cb358380d2e3de08a90";

async function readJsonOrThrow(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) {
    throw new Error("Received empty response");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid JSON response: ${raw.slice(0, 120)}`);
  }
}

async function querySubgraph<T>(endpoint: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph request failed (${response.status})`);
  }

  const payload = (await readJsonOrThrow(response)) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    const message = payload.errors[0]?.message ?? "Unknown GraphQL error";
    throw new Error(`Subgraph error: ${message}`);
  }

  if (!payload.data) {
    throw new Error("Subgraph response has no data");
  }

  return payload.data;
}

export async function fetchV3SubgraphPoolCandidates(
  endpoint: string,
  limit = 40,
): Promise<V3SubgraphPoolCandidate[]> {
  const query = `
    query TopPools($limit: Int!) {
      pools(
        first: $limit,
        orderBy: totalValueLockedUSD,
        orderDirection: desc,
        where: { liquidity_gt: \"0\" }
      ) {
        id
        feeTier
        totalValueLockedUSD
        volumeUSD
        txCount
      }
    }
  `;

  const data = await querySubgraph<{ pools?: Array<Record<string, string>> }>(endpoint, query, { limit });
  const pools = data.pools ?? [];

  const parsed: V3SubgraphPoolCandidate[] = [];
  for (const pool of pools) {
    const id = pool.id;
    if (!id || !isAddress(id)) {
      continue;
    }

    const feeTierRaw = pool.feeTier ?? "0";
    const feeTier = Number.parseInt(feeTierRaw, 10);
    if (!Number.isFinite(feeTier)) {
      continue;
    }

    parsed.push({
      id: getAddress(id),
      feeTier,
      totalValueLockedUSD: pool.totalValueLockedUSD ?? "0",
      volumeUSD: pool.volumeUSD ?? "0",
      txCount: pool.txCount ?? "0",
    });
  }

  return parsed;
}

export async function fetchV4SubgraphMarketSnapshot(endpoint: string): Promise<V4SubgraphMarketSnapshot | null> {
  const query = `
    query V4MarketSnapshot($id: ID!) {
      poolManager(id: $id) {
        poolCount
        txCount
        totalVolumeUSD
        totalFeesUSD
        totalValueLockedUSD
      }
    }
  `;

  const data = await querySubgraph<{
    poolManager?: {
      poolCount?: string;
      txCount?: string;
      totalVolumeUSD?: string;
      totalFeesUSD?: string;
      totalValueLockedUSD?: string;
    };
  }>(endpoint, query, { id: V4_POOL_MANAGER_ID });

  if (!data.poolManager) {
    return null;
  }

  return {
    poolCount: data.poolManager.poolCount,
    txCount: data.poolManager.txCount,
    totalVolumeUSD: data.poolManager.totalVolumeUSD,
    totalFeesUSD: data.poolManager.totalFeesUSD,
    totalValueLockedUSD: data.poolManager.totalValueLockedUSD,
  };
}

function flattenRoute(route: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(route)) {
    return [];
  }

  const flattened: Array<Record<string, unknown>> = [];

  for (const segment of route) {
    if (Array.isArray(segment)) {
      for (const hop of segment) {
        if (hop && typeof hop === "object") {
          flattened.push(hop as Record<string, unknown>);
        }
      }
      continue;
    }

    if (segment && typeof segment === "object") {
      flattened.push(segment as Record<string, unknown>);
    }
  }

  return flattened;
}

function toCurrency(chainId: number, value: unknown): Currency | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const addressValue = (value as { address?: unknown }).address;
  const decimalsValue = (value as { decimals?: unknown }).decimals;
  const symbolValue = (value as { symbol?: unknown }).symbol;

  if (typeof addressValue !== "string") {
    return null;
  }

  if (addressValue.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    return Ether.onChain(chainId);
  }

  if (!isAddress(addressValue)) {
    return null;
  }

  const decimals = typeof decimalsValue === "string" ? Number.parseInt(decimalsValue, 10) : Number(decimalsValue ?? 18);
  const safeDecimals = Number.isFinite(decimals) ? Math.min(Math.max(Math.trunc(decimals), 0), 255) : 18;
  const symbol = typeof symbolValue === "string" ? symbolValue : "TKN";

  return new Token(chainId, getAddress(addressValue), safeDecimals, symbol);
}

function validateV4PoolId(chainId: number, hop: Record<string, unknown>): boolean | undefined {
  if (hop.type !== "v4-pool") {
    return undefined;
  }

  const poolId = typeof hop.address === "string" ? hop.address.toLowerCase() : null;
  const fee = typeof hop.fee === "string" ? Number.parseInt(hop.fee, 10) : Number(hop.fee);
  const tickSpacing = typeof hop.tickSpacing === "string" ? Number.parseInt(hop.tickSpacing, 10) : Number(hop.tickSpacing);
  const hooks = typeof hop.hooks === "string" ? hop.hooks : "0x0000000000000000000000000000000000000000";
  const currencyIn = toCurrency(chainId, hop.tokenIn);
  const currencyOut = toCurrency(chainId, hop.tokenOut);

  if (!poolId || !Number.isFinite(fee) || !Number.isFinite(tickSpacing) || !currencyIn || !currencyOut) {
    return false;
  }

  try {
    const computedPoolId = V4Pool.getPoolId(currencyIn, currencyOut, fee, tickSpacing, hooks).toLowerCase();
    return computedPoolId === poolId;
  } catch {
    return false;
  }
}

export async function fetchUniswapApiQuoteProbe(args: {
  config: RuntimeConfig;
  swapper: Address;
  tokenIn: Address;
  tokenOut: Address;
  amount: string;
}): Promise<UniswapApiQuoteProbe | null> {
  const { config, swapper, tokenIn, tokenOut, amount } = args;

  if (!config.uniswapApiKey) {
    return null;
  }

  const endpoint = `${config.uniswapTradeApiBase}/v1/quote`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.uniswapApiKey,
      "x-universal-router-version": "2.0",
    },
    body: JSON.stringify({
      type: "EXACT_INPUT",
      amount,
      tokenInChainId: config.chainId,
      tokenOutChainId: config.chainId,
      tokenIn,
      tokenOut,
      swapper,
      autoSlippage: "DEFAULT",
      routingPreference: "BEST_PRICE",
      protocols: ["V3", "V4"],
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await readJsonOrThrow(response)) as {
    routing?: string;
    quote?: {
      route?: unknown;
      routeString?: string;
      priceImpact?: number;
      gasFeeUSD?: string;
    };
  };

  const routing = payload.routing;
  if (!routing) {
    return null;
  }

  const hops = flattenRoute(payload.quote?.route);
  const includesV4 = hops.some((hop) => hop.type === "v4-pool") || (payload.quote?.routeString ?? "").includes("[V4]");
  const v4Validations = hops
    .map((hop) => validateV4PoolId(config.chainId, hop))
    .filter((value): value is boolean => typeof value === "boolean");
  const v4PoolIdValidated = v4Validations.length > 0 ? v4Validations.every(Boolean) : undefined;

  return {
    routing,
    routeString: payload.quote?.routeString,
    includesV4,
    v4PoolIdValidated,
    priceImpact: payload.quote?.priceImpact,
    gasFeeUsd: payload.quote?.gasFeeUSD,
  };
}

export async function fetchUniswapAiContextSnippet(url: string, maxChars = 1400): Promise<string | null> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "text/plain,text/markdown;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    return null;
  }

  const text = await response.text();
  if (!text || text.trim().length === 0) {
    return null;
  }

  const compact = text.replace(/\r/g, "").trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  return compact.slice(0, maxChars);
}
