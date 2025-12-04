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
  positionKeypair?: Keypair; // Опциональный positionKeypair для использования при retry (чтобы адрес позиции не менялся)
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
 * Preview actual amounts that will be used for opening a position
 * This is useful for showing users the real amounts before they confirm
 */
export async function previewPositionAmounts(
  connection: Connection,
  params: {
    poolAddress: string;
    strategy: PositionStrategy;
    rangeInterval: number;
    tokenXAmount: string; // в минимальных единицах
    tokenYAmount: string; // в минимальных единицах
  },
): Promise<{
  actualTokenXAmount: string;
  actualTokenYAmount: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
}> {
  const { poolAddress, strategy, rangeInterval, tokenXAmount, tokenYAmount } = params;

  // Create DLMM pool instance
  const dlmmPool = await createDlmmPool(connection, poolAddress);
  
  // Get active bin
  const activeBin = await dlmmPool.getActiveBin();
  const activeBinId = activeBin.binId;

  // Calculate min and max bin IDs based on strategy
  let minBinId: number;
  let maxBinId: number;

  if (strategy === 'oneSide') {
    minBinId = activeBinId;
    maxBinId = activeBinId + rangeInterval * 2;
  } else {
    minBinId = activeBinId - rangeInterval;
    maxBinId = activeBinId + rangeInterval;
  }

  // Convert amounts to BN
  const tokenXAmountBN = new BN(tokenXAmount);
  const tokenYAmountBN = new BN(tokenYAmount);

  let actualTokenXAmountBN: BN;
  let actualTokenYAmountBN: BN;

  if (strategy === 'balance') {
    // Balance strategy: autoFillYByStrategy пересчитывает Token Y
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
    actualTokenXAmountBN = tokenXAmountBN;
    actualTokenYAmountBN = autoFilledY;
  } else {
    // Imbalance and oneSide: используем указанные пользователем amounts
    actualTokenXAmountBN = tokenXAmountBN;
    actualTokenYAmountBN = tokenYAmountBN;
  }

  // Get token decimals using the proper utility function
  const tokenXMint = (dlmmPool.lbPair as any).tokenXMint;
  const tokenYMint = (dlmmPool.lbPair as any).tokenYMint;
  
  // Import getTokenDecimals function
  const { getTokenDecimals } = await import('../utils/tokenUtils.js');
  
  // Get decimals using the proper utility that handles known tokens correctly
  const tokenXDecimals = await getTokenDecimals(connection, tokenXMint.toBase58());
  const tokenYDecimals = await getTokenDecimals(connection, tokenYMint.toBase58());

  return {
    actualTokenXAmount: actualTokenXAmountBN.toString(),
    actualTokenYAmount: actualTokenYAmountBN.toString(),
    tokenXDecimals,
    tokenYDecimals,
  };
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

  // Create position keypair (или используем переданный для retry)
  const positionKeypair = params.positionKeypair || Keypair.generate();

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
  // ВСЕГДА получаем свежий blockhash перед созданием транзакции
  // Используем 'confirmed' вместо 'finalized' для более быстрого получения
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  
  if (Array.isArray(createPositionTx)) {
    // Обрабатываем все транзакции параллельно
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
 * Returns array of transactions if multiple are needed (e.g., when removing liquidity)
 */
export async function createClosePositionTransaction(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  ownerPublicKey: PublicKey,
): Promise<VersionedTransaction | VersionedTransaction[]> {
  const dlmmPool = await createDlmmPool(connection, poolAddress);
  const positionPubKey = new PublicKey(positionAddress);

  // Проверяем владельца аккаунта позиции перед попыткой закрытия
  try {
    const accountInfo = await connection.getAccountInfo(positionPubKey, 'confirmed');
    if (!accountInfo) {
      throw new Error(`Position account ${positionAddress} does not exist. It may have already been closed.`);
    }
    
    // Проверяем, что аккаунт принадлежит программе Meteora DLMM
    const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    if (!accountInfo.owner.equals(METEORA_DLMM_PROGRAM_ID)) {
      // Если аккаунт принадлежит System Program, значит позиция уже закрыта
      if (accountInfo.owner.equals(new PublicKey('11111111111111111111111111111111'))) {
        throw new Error(`Position ${positionAddress} has already been closed. The account is owned by System Program.`);
      }
      throw new Error(`Position account ${positionAddress} is owned by a different program (${accountInfo.owner.toBase58()}), expected Meteora DLMM.`);
    }
  } catch (error: any) {
    // Если ошибка уже содержит понятное сообщение, пробрасываем её
    if (error.message && (error.message.includes('already been closed') || error.message.includes('does not exist'))) {
      throw error;
    }
    // Иначе пробуем продолжить - возможно, это временная проблема с RPC
    console.warn(`[ClosePosition] Warning: Could not verify position account ownership: ${error.message}`);
  }

  // Получаем актуальные данные позиции перед закрытием
  const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerPublicKey);
  const position = userPositions.find(p => p.publicKey.equals(positionPubKey));
  
  if (!position) {
    throw new Error(`Position ${positionAddress} not found in user positions. It may have already been closed or does not belong to this user.`);
  }

  // Всегда используем removeLiquidity с shouldClaimAndClose: true для безопасного закрытия
  // Это гарантирует удаление всей ликвидности перед закрытием позиции
  const positionBinData = position.positionData?.positionBinData || [];
  
  console.log(`[ClosePosition] Position ${positionAddress}: bins count = ${positionBinData.length}`);
  
  let closePositionTx: Transaction | Transaction[];

  // Если есть данные о bins, всегда используем removeLiquidity
  if (positionBinData.length > 0) {
    // Конвертируем binId в число, обрабатывая случаи когда это BN или undefined
    const binIdsToRemove = positionBinData
      .map((bin: any) => {
        if (!bin || bin.binId === undefined || bin.binId === null) {
          return null;
        }
        // Если binId это BN объект, конвертируем в число
        if (bin.binId instanceof BN || (bin.binId && typeof bin.binId.toNumber === 'function')) {
          try {
            return bin.binId.toNumber();
          } catch (e) {
            console.warn(`[ClosePosition] Failed to convert binId to number:`, e);
            return null;
          }
        }
        // Если это уже число, возвращаем как есть
        if (typeof bin.binId === 'number') {
          return bin.binId;
        }
        // Пробуем преобразовать в число
        const numId = Number(bin.binId);
        return isNaN(numId) ? null : numId;
      })
      .filter((id: number | null): id is number => id !== null && typeof id === 'number');
    
    if (binIdsToRemove.length === 0) {
      console.warn(`[ClosePosition] Position has bins but no valid bin IDs, trying direct close`);
      // Если нет валидных bin IDs, пробуем закрыть напрямую
      // closePosition принимает position как LbPosition объект
      closePositionTx = await dlmmPool.closePosition({
        owner: ownerPublicKey,
        position: position,
      });
    } else {
      // Sort bin IDs to get correct range
      binIdsToRemove.sort((a: number, b: number) => a - b);

      console.log(`[ClosePosition] Removing liquidity from bins ${binIdsToRemove[0]} to ${binIdsToRemove[binIdsToRemove.length - 1]}`);

      // Remove all liquidity (100%) and close position
      // Используем правильный формат параметра согласно документации SDK
      closePositionTx = await dlmmPool.removeLiquidity({
        position: position.publicKey,
        user: ownerPublicKey,
        fromBinId: binIdsToRemove[0],
        toBinId: binIdsToRemove[binIdsToRemove.length - 1],
        bps: new BN(100 * 100), // 100% (10000 bps) для всех bins
        shouldClaimAndClose: true, // Claim swap fees and close position together
      });
    }
  } else {
    // Если нет данных о bins, пробуем закрыть напрямую
    // Но если это вызовет ошибку NonEmptyPosition, используем альтернативный подход
    console.log(`[ClosePosition] No bin data found, trying direct close`);
    try {
      // closePosition принимает position как LbPosition объект
      closePositionTx = await dlmmPool.closePosition({
        owner: ownerPublicKey,
        position: position,
      });
    } catch (error: any) {
      // Если получили ошибку NonEmptyPosition, значит позиция не пустая
      // Нужно использовать removeLiquidity, но для этого нужны актуальные данные
      if (error?.message?.includes('NonEmptyPosition') || error?.code === 6030) {
        console.warn(`[ClosePosition] Direct close failed with NonEmptyPosition error, refreshing position data`);
        
        // Получаем актуальные данные позиции еще раз
        const { userPositions: refreshedPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerPublicKey);
        const refreshedPosition = refreshedPositions.find(p => p.publicKey.equals(positionPubKey));
        
        if (refreshedPosition?.positionData?.positionBinData && refreshedPosition.positionData.positionBinData.length > 0) {
          const refreshedBinData = refreshedPosition.positionData.positionBinData;
          // Конвертируем binId в число, обрабатывая случаи когда это BN или undefined
          const binIds = refreshedBinData
            .map((bin: any) => {
              if (!bin || bin.binId === undefined || bin.binId === null) {
                return null;
              }
              // Если binId это BN объект, конвертируем в число
              if (bin.binId instanceof BN || (bin.binId && typeof bin.binId.toNumber === 'function')) {
                try {
                  return bin.binId.toNumber();
                } catch (e) {
                  console.warn(`[ClosePosition] Failed to convert binId to number:`, e);
                  return null;
                }
              }
              // Если это уже число, возвращаем как есть
              if (typeof bin.binId === 'number') {
                return bin.binId;
              }
              // Пробуем преобразовать в число
              const numId = Number(bin.binId);
              return isNaN(numId) ? null : numId;
            })
            .filter((id: number | null): id is number => id !== null && typeof id === 'number');
          
          if (binIds.length > 0) {
            binIds.sort((a: number, b: number) => a - b);
            console.log(`[ClosePosition] Found ${binIds.length} bins after refresh, using removeLiquidity`);
            closePositionTx = await dlmmPool.removeLiquidity({
              position: refreshedPosition.publicKey,
              user: ownerPublicKey,
              fromBinId: binIds[0],
              toBinId: binIds[binIds.length - 1],
              bps: new BN(100 * 100), // 100% (10000 bps) для всех bins
              shouldClaimAndClose: true,
            });
          } else {
            throw new Error('Position has bins but no valid bin IDs after refresh');
          }
        } else {
          throw new Error('Position appears empty but close failed - may need manual intervention');
        }
      } else {
        throw error; // Перебрасываем другие ошибки
      }
    }
  }

  // Convert to VersionedTransaction(s)
  const latestBlockhash = await connection.getLatestBlockhash('finalized');
  if (Array.isArray(closePositionTx)) {
    // Если массив транзакций, конвертируем все
    return closePositionTx.map(tx => {
      tx.recentBlockhash = latestBlockhash.blockhash;
      tx.feePayer = ownerPublicKey;
      return new VersionedTransaction(tx.compileMessage());
    });
  } else {
    // Если одна транзакция
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
 * Get actual token amounts from position after it's created
 * This calculates real amounts from position bins, which may differ from preview
 */
export async function getActualPositionAmounts(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  ownerPublicKey: PublicKey,
): Promise<{
  actualTokenXAmount: string;
  actualTokenYAmount: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
}> {
  const binData = await getPositionBinData(connection, poolAddress, positionAddress, ownerPublicKey);
  
  // Суммируем все токены из всех bins
  let totalX = new BN(0);
  let totalY = new BN(0);
  
  for (const bin of binData) {
    totalX = totalX.add(bin.amountX);
    totalY = totalY.add(bin.amountY);
  }
  
  // Получаем decimals токенов
  const dlmmPool = await createDlmmPool(connection, poolAddress);
  const tokenXMint = (dlmmPool.lbPair as any).tokenXMint;
  const tokenYMint = (dlmmPool.lbPair as any).tokenYMint;
  
  const { getTokenDecimals } = await import('../utils/tokenUtils.js');
  const tokenXDecimals = await getTokenDecimals(connection, tokenXMint.toBase58());
  const tokenYDecimals = await getTokenDecimals(connection, tokenYMint.toBase58());
  
  return {
    actualTokenXAmount: totalX.toString(),
    actualTokenYAmount: totalY.toString(),
    tokenXDecimals,
    tokenYDecimals,
  };
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
