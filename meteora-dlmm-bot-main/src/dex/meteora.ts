import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
import DLMM, { StrategyType, autoFillYByStrategy } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { request } from 'undici';
import { CONFIG } from '../config.js';

/**
 * Lightweight helpers around Meteora DLMM pool discovery.
 * For direct DLMM interactions (adding liquidity, custom quotes), use the SDK.
 */

export type DlmmPair = {
  address: string;           // pool address (LB pair)
  tokenXMint: string;
  tokenYMint: string;
  binStep: number;
  baseFeeBps?: number;
  // other fields if present in API
};

export type PositionStrategy = 'balance' | 'imbalance' | 'oneSide';

export type OpenPositionParams = {
  poolAddress: string;
  userPublicKey: PublicKey;
  strategy: PositionStrategy;
  rangeInterval: number; // количество bins с каждой стороны
  tokenXAmount: string; // в минимальных единицах (lamports)
  tokenYAmount: string; // в минимальных единицах (lamports)
};

export async function fetchDlmmPairs(): Promise<DlmmPair[]> {
  const url = CONFIG.dlmmApiBase + '/pair/all';
  const res = await request(url);
  if (res.statusCode !== 200) {
    throw new Error('DLMM API error: ' + res.statusCode);
  }
  const data = (await res.body.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error('DLMM API error: invalid response');
  }
  // Expecting array of objects; keep only essentials
  return data.map((p: any) => ({
    address: p.address ?? p.lb_pair_address ?? p.id ?? '',
    tokenXMint: p.tokenXMint ?? p.base_mint ?? p.tokenX?.mint ?? '',
    tokenYMint: p.tokenYMint ?? p.quote_mint ?? p.tokenY?.mint ?? '',
    binStep: Number(p.binStep ?? p.bin_step ?? p.bin_step_bps ?? 0),
    baseFeeBps: Number(p.baseFeeBps ?? p.base_fee_bps ?? p.baseFee ?? 0) || undefined,
  })) as DlmmPair[];
}

/**
 * Optional: instantiate a pool via SDK (useful for advanced ops)
 */
export async function createDlmmPool(connection: Connection, poolAddress: string) {
  const pub = new PublicKey(poolAddress);
  return DLMM.create(connection, pub);
}

/**
 * Create a transaction to open a position in a Meteora DLMM pool
 */
export async function createOpenPositionTransaction(
  connection: Connection,
  params: OpenPositionParams,
): Promise<{ transaction: VersionedTransaction; positionKeypair: Keypair }> {
  const { poolAddress, userPublicKey, strategy, rangeInterval, tokenXAmount, tokenYAmount } = params;

  // Валидация параметров
  if (rangeInterval < 1 || rangeInterval > 100) {
    throw new Error('Диапазон должен быть от 1 до 100');
  }
  
  const tokenXAmountNum = parseFloat(tokenXAmount);
  const tokenYAmountNum = parseFloat(tokenYAmount);
  
  if (isNaN(tokenXAmountNum) || tokenXAmountNum <= 0) {
    throw new Error('Количество Token X должно быть положительным числом');
  }
  
  if (isNaN(tokenYAmountNum) || (strategy !== 'oneSide' && tokenYAmountNum <= 0)) {
    throw new Error('Количество Token Y должно быть положительным числом для выбранной стратегии');
  }

  // Create DLMM pool instance
  let dlmmPool: Awaited<ReturnType<typeof createDlmmPool>>;
  try {
    dlmmPool = await createDlmmPool(connection, poolAddress);
  } catch (error) {
    throw new Error(`Не удалось создать экземпляр пула: ${(error as Error).message}`);
  }

  // Get active bin (получаем один раз для оптимизации)
  let activeBin;
  try {
    activeBin = await dlmmPool.getActiveBin();
  } catch (error) {
    throw new Error(`Не удалось получить активный bin: ${(error as Error).message}`);
  }
  const activeBinId = activeBin.binId;

  // Calculate min and max bin IDs based on strategy
  let minBinId: number;
  let maxBinId: number;

  if (strategy === 'oneSide') {
    // One side: только в одну сторону от активного bin
    minBinId = activeBinId;
    maxBinId = activeBinId + rangeInterval * 2;
  } else {
    // Balance and Imbalance: bins с обеих сторон
    minBinId = activeBinId - rangeInterval;
    maxBinId = activeBinId + rangeInterval;
  }

  // Create position keypair
  const positionKeypair = Keypair.generate();

  // Convert amounts to BN (BigNumber)
  const tokenXAmountBN = new BN(tokenXAmount);
  const tokenYAmountBN = new BN(tokenYAmount);

  // Create position transaction based on strategy
  // All strategies use StrategyType.Spot, the difference is in the amounts and bin ranges
  let createPositionTx: Transaction | Transaction[];

  if (strategy === 'balance') {
    // Balance strategy: 50/50 распределение - используем autoFillYByStrategy для баланса
    const autoFilledY = autoFillYByStrategy(
      activeBinId,
      (dlmmPool.lbPair as any).binStep,
      tokenXAmountBN,
      activeBin.xAmount,
      activeBin.yAmount,
      minBinId,
      maxBinId,
      StrategyType.Spot,
    );
    createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: userPublicKey,
      totalXAmount: tokenXAmountBN,
      totalYAmount: autoFilledY,
      strategy: {
        maxBinId, // Важно: порядок maxBinId, minBinId как в документации
        minBinId,
        strategyType: StrategyType.Spot,
      },
    });
  } else if (strategy === 'imbalance') {
    // Imbalance strategy: неравномерное распределение - используем указанные пользователем amounts
    createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: userPublicKey,
      totalXAmount: tokenXAmountBN,
      totalYAmount: tokenYAmountBN,
      strategy: {
        maxBinId, // Важно: порядок maxBinId, minBinId как в документации
        minBinId,
        strategyType: StrategyType.Spot,
      },
    });
  } else {
    // One side strategy: односторонняя позиция - только один токен
    createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: userPublicKey,
      totalXAmount: tokenXAmountBN,
      totalYAmount: tokenYAmountBN, // может быть 0 для односторонней позиции
      strategy: {
        maxBinId, // Важно: порядок maxBinId, minBinId как в документации
        minBinId,
        strategyType: StrategyType.Spot,
      },
    });
  }

  // Convert Transaction to VersionedTransaction if needed
  // Note: position keypair needs to be signed separately by the client
  // According to SDK docs, transactions should be signed with [user, positionKeypair]
  // If multiple transactions, we return all of them for parallel processing
  if (Array.isArray(createPositionTx)) {
    // Обрабатываем все транзакции параллельно
    const latestBlockhash = await connection.getLatestBlockhash('finalized');
    const versionedTxs = createPositionTx.map(tx => {
      tx.recentBlockhash = latestBlockhash.blockhash;
      tx.feePayer = userPublicKey;
      return new VersionedTransaction(tx.compileMessage());
    });
    
    // Возвращаем первую транзакцию для обратной совместимости
    // В будущем можно вернуть массив для параллельной обработки
    return {
      transaction: versionedTxs[0],
      positionKeypair,
    };
  } else {
    const latestBlockhash = await connection.getLatestBlockhash('finalized');
    createPositionTx.recentBlockhash = latestBlockhash.blockhash;
    createPositionTx.feePayer = userPublicKey;
    const versionedTx = new VersionedTransaction(createPositionTx.compileMessage());
    
    return {
      transaction: versionedTx,
      positionKeypair,
    };
  }
}

/**
 * Close a position in a Meteora DLMM pool
 */
export async function createClosePositionTransaction(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  ownerPublicKey: PublicKey,
): Promise<VersionedTransaction> {
  const dlmmPool = await createDlmmPool(connection, poolAddress);
  const positionPubKey = new PublicKey(positionAddress);

  // Get the position object first
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerPublicKey);
  const position = userPositions.find(p => p.publicKey.equals(positionPubKey));
  
  if (!position) {
    throw new Error('Position not found');
  }

  // Close position transaction
  const closePositionTx = await dlmmPool.closePosition({
    owner: ownerPublicKey,
    position: position,
  });

  // Convert to VersionedTransaction
  // Обрабатываем массив транзакций параллельно (берем первую основную)
  const latestBlockhash = await connection.getLatestBlockhash('finalized');
  if (Array.isArray(closePositionTx)) {
    const tx = closePositionTx[0];
    tx.recentBlockhash = latestBlockhash.blockhash;
    tx.feePayer = ownerPublicKey;
    return new VersionedTransaction(tx.compileMessage());
  } else {
    closePositionTx.recentBlockhash = latestBlockhash.blockhash;
    closePositionTx.feePayer = ownerPublicKey;
    return new VersionedTransaction(closePositionTx.compileMessage());
  }
}

/**
 * Get position information from pool
 */
export async function getPositionInfo(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  ownerPublicKey: PublicKey,
): Promise<{
  positionData: any;
  activeBin: { binId: number; price: string };
}> {
  const dlmmPool = await createDlmmPool(connection, poolAddress);
  const positionPubKey = new PublicKey(positionAddress);

  const { userPositions, activeBin } = await dlmmPool.getPositionsByUserAndLbPair(ownerPublicKey);
  const position = userPositions.find(p => p.publicKey.equals(positionPubKey));
  
  if (!position) {
    throw new Error('Position not found');
  }

  return {
    positionData: position.positionData,
    activeBin,
  };
}

/**
 * Get claimable swap fees for a position
 */
export async function getClaimableSwapFees(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  ownerPublicKey: PublicKey,
): Promise<{ tokenX: BN; tokenY: BN }> {
  const dlmmPool = await createDlmmPool(connection, poolAddress);
  const positionPubKey = new PublicKey(positionAddress);

  // Get position first to access position data
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerPublicKey);
  const position = userPositions.find(p => p.publicKey.equals(positionPubKey));
  
  if (!position) {
    throw new Error('Position not found');
  }

  // Extract claimable fees from position data
  // The position data structure may vary, so we try multiple possible property names
  const positionData = position.positionData as any;
  const feeXAmount = positionData.feeXAmount || positionData.feeXExcludeTransferFee || positionData.claimableFeeXAmount || new BN(0);
  const feeYAmount = positionData.feeYAmount || positionData.feeYExcludeTransferFee || positionData.claimableFeeYAmount || new BN(0);
  
  // Convert to BN if they're not already
  const tokenX = feeXAmount instanceof BN ? feeXAmount : new BN(feeXAmount?.toString() || '0');
  const tokenY = feeYAmount instanceof BN ? feeYAmount : new BN(feeYAmount?.toString() || '0');
  
  return {
    tokenX,
    tokenY,
  };
}

/**
 * Get position bin data (real distribution of tokens across bins)
 */
export async function getPositionBinData(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  ownerPublicKey: PublicKey,
): Promise<Array<{ binId: number; amountX: BN; amountY: BN }>> {
  const dlmmPool = await createDlmmPool(connection, poolAddress);
  const positionPubKey = new PublicKey(positionAddress);

  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerPublicKey);
  const position = userPositions.find(p => p.publicKey.equals(positionPubKey));

  if (!position) {
    throw new Error('Position not found');
  }

  // positionBinData содержит реальное распределение токенов по bins
  const binData = position.positionData.positionBinData || [];
  return binData.map((bin: any) => ({
    binId: bin.binId,
    amountX: bin.amountX || new BN(0),
    amountY: bin.amountY || new BN(0),
  }));
}

/**
 * Get pool data from Meteora API (volume, fees, liquidity)
 */
export async function getPoolDataFromAPI(poolAddress: string): Promise<{
  volume24h: number;
  fees24h: number;
  liquidity: number;
  baseFeeBps: number;
}> {
  try {
    const response = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch pool data: ${response.status}`);
    }
    const data = await response.json();
    
    return {
      volume24h: parseFloat(data.trade_volume_24h || data.volume_24h || '0'),
      fees24h: parseFloat(data.fees_24h || '0'),
      liquidity: parseFloat(data.liquidity || data.total_liquidity || data.tvl || '0'),
      baseFeeBps: Number(data.base_fee_bps || data.baseFeeBps || 0),
    };
  } catch (error) {
    console.error(`Error fetching pool data for ${poolAddress}:`, error);
    throw error;
  }
}
