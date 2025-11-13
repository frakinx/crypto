import { Connection, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { request } from 'undici';

type QuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: number; // integer in smallest units
  slippageBps: number;
  onlyDirectRoutes?: boolean;
  dexes?: string[]; // labels
};

export type JupiterRouteLeg = {
  swapInfo?: Record<string, unknown>;
  percent?: number;
  bps?: number;
};

export type JupiterQuoteResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct?: string;
  platformFee?: unknown;
  routePlan: JupiterRouteLeg[];
  [key: string]: unknown;
};

type JupiterSwapResponse = {
  swapTransaction: string;
  lastValidBlockHeight?: number;
};

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (CONFIG.jup.apiKey) {
    headers['x-api-key'] = CONFIG.jup.apiKey;
  }
  return headers;
}

export async function getQuote(params: QuoteParams): Promise<JupiterQuoteResponse> {
  const url = new URL(`${CONFIG.jup.swapBase}/quote`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', String(params.amount));
  url.searchParams.set('slippageBps', String(params.slippageBps));
  if (params.onlyDirectRoutes) url.searchParams.set('onlyDirectRoutes', 'true');
  if (params.dexes && params.dexes.length) url.searchParams.set('dexes', params.dexes.join(','));
  const res = await request(url, { method: 'GET', headers: buildHeaders() });
  if (res.statusCode !== 200) {
    throw new Error('Jupiter quote error: ' + res.statusCode);
  }
  const data = (await res.body.json()) as unknown;
  if (!data || typeof data !== 'object') {
    throw new Error('Jupiter quote error: invalid response');
  }
  return data as JupiterQuoteResponse;
}

export async function createSwapTransaction(
  _connection: Connection,
  user: PublicKey,
  route: JupiterQuoteResponse, // the 'route' object from /quote
  asLegacyTransaction = false,
): Promise<VersionedTransaction> {
  const url = `${CONFIG.jup.swapBase}/swap`;
  const body = {
    quoteResponse: route,
    userPublicKey: user.toBase58(),
    wrapAndUnwrapSol: true,
    asLegacyTransaction,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: 'auto',
  };

  const res = await request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: buildHeaders(),
  });
  if (res.statusCode !== 200) {
    const text = await res.body.text();
    throw new Error('Jupiter swap error: ' + res.statusCode + ' ' + text);
  }
  const data = (await res.body.json()) as JupiterSwapResponse;
  if (!data || typeof data.swapTransaction !== 'string') {
    throw new Error('Jupiter swap error: invalid response');
  }
  const swapTxBase64 = data.swapTransaction;
  const txBytes = Buffer.from(swapTxBase64, 'base64');
  const tx = VersionedTransaction.deserialize(txBytes);
  return tx;
}
