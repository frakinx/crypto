import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import { getQuote, createSwapTransaction } from '../dex/jupiter.js';
import { signAndSend } from '../execution/trader.js';
import { CONFIG } from '../config.js';
import type { PositionInfo, HedgeSwapInfo } from './types.js';
import type { AdminConfig } from './config.js';
import { StrategyCalculator } from './strategyCalculator.js';
import { PositionStorage } from './storage.js';

/**
 * Модуль управления hedge swap для Mirror Swapping стратегии
 * Выполняет постоянные hedge swaps от открытия позиции до ее закрытия
 */

export class HedgeManager {
  private connection: Connection;
  private userKeypair: Keypair;
  private strategyCalculator: StrategyCalculator;
  private storage: PositionStorage;
  private hedgePositions: Map<string, {
    lastHedgePrice: number;
    lastHedgeAmount: string;
    lastHedgeDirection: 'buy' | 'sell';
    hedgeCount: number; // Количество выполненных hedge операций
    accumulatedChangeSinceLastHedge: number; // Накопленное изменение цены с момента последнего hedge (%)
    lastCheckedPrice: number; // Последняя проверенная цена (для правильного накопления изменений)
    hedgeInterval?: NodeJS.Timeout;
  }> = new Map();

  constructor(
    connection: Connection,
    userKeypair: Keypair,
    strategyCalculator: StrategyCalculator,
  ) {
    this.connection = connection;
    this.userKeypair = userKeypair;
    this.strategyCalculator = strategyCalculator;
    this.storage = new PositionStorage();
  }

  /**
   * Запустить постоянный hedge swap для позиции
   */
  startHedging(
    position: PositionInfo,
    config: AdminConfig,
    positionBinData?: Array<{ binId: number; amountX: any; amountY: any }>,
  ): void {
    if (!config.mirrorSwap.enabled) {
      return;
    }

    // Останавливаем предыдущий hedge если есть
    this.stopHedging(position.positionAddress);

    // Выполняем первый hedge сразу
    this.executeHedge(position, config, positionBinData).catch(err => {
      console.error(`Error in initial hedge for position ${position.positionAddress}:`, err);
    });

    // Настраиваем периодический hedge
    // При каждом hedge получаем актуальные данные о позиции для правильного расчета
    const hedgeInterval = setInterval(async () => {
      try {
        // Проверяем, что позиция еще активна
        if (position.status !== 'active') {
          console.log(`Position ${position.positionAddress} is no longer active (status: ${position.status}), stopping hedge`);
          this.stopHedging(position.positionAddress);
          return;
        }

        // Получаем актуальное распределение токенов в позиции при каждом hedge
        let currentBinData: Array<{ binId: number; amountX: any; amountY: any }> | undefined;
        try {
          const { getPositionBinData } = await import('../dex/meteora.js');
          currentBinData = await getPositionBinData(
            this.connection,
            position.poolAddress,
            position.positionAddress,
            new PublicKey(position.userAddress),
          );
        } catch (error) {
          const errorMsg = (error as Error).message;
          // Если позиция не найдена, значит она закрыта - останавливаем hedge
          if (errorMsg.includes('not found') || errorMsg.includes('Position not found')) {
            console.log(`Position ${position.positionAddress} not found, stopping hedge`);
            this.stopHedging(position.positionAddress);
            return;
          }
          console.warn(`Failed to get position bin data for periodic hedge: ${errorMsg}`);
          // Продолжаем без binData
        }

        // Обновляем текущую цену позиции перед hedge
        const { PriceMonitor } = await import('./priceMonitor.js');
        const priceMonitor = new PriceMonitor(this.connection);
        const currentPrice = await priceMonitor.getPoolPrice(position.poolAddress);
        position.currentPrice = currentPrice;

        await this.executeHedge(position, config, currentBinData);
      } catch (error) {
        const errorMsg = (error as Error).message;
        // Если позиция не найдена, останавливаем hedge
        if (errorMsg.includes('not found') || errorMsg.includes('Position not found')) {
          console.log(`Position ${position.positionAddress} not found during hedge, stopping`);
          this.stopHedging(position.positionAddress);
          return;
        }
        console.error(`Error in periodic hedge for position ${position.positionAddress}:`, error);
      }
    }, config.monitoring.priceUpdateIntervalMs);

    this.hedgePositions.set(position.positionAddress, {
      lastHedgePrice: position.initialPrice,
      lastHedgeAmount: '0',
      lastHedgeDirection: 'buy',
      hedgeCount: 0,
      accumulatedChangeSinceLastHedge: 0, // Начинаем с 0
      lastCheckedPrice: position.initialPrice, // Инициализируем последнюю проверенную цену
      hedgeInterval,
    });
  }

  /**
   * Остановить hedge swap для позиции
   */
  stopHedging(positionAddress: string): void {
    const hedge = this.hedgePositions.get(positionAddress);
    if (hedge?.hedgeInterval) {
      clearInterval(hedge.hedgeInterval);
    }
    this.hedgePositions.delete(positionAddress);
  }

  /**
   * Выполнить hedge swap
   */
  async executeHedge(
    position: PositionInfo,
    config: AdminConfig,
    positionBinData?: Array<{ binId: number; amountX: any; amountY: any }>,
  ): Promise<string | null> {
    // Проверяем, что позиция еще активна
    if (position.status !== 'active') {
      console.log(`Skipping hedge for position ${position.positionAddress}: status is ${position.status}`);
      this.stopHedging(position.positionAddress);
      return null;
    }

    if (!config.mirrorSwap.enabled) {
      return null;
    }

    const currentPrice = position.currentPrice || position.initialPrice;
    const hedgeInfo = this.hedgePositions.get(position.positionAddress);
    
    // Проверяем, изменилась ли цена достаточно для нового hedge
    const minPriceChange = config.mirrorSwap.minPriceChangePercent ?? 0.1;
    const significantChangeThreshold = 2.0; // Порог для накопленного изменения (2%)
    
    if (hedgeInfo) {
      // Изменение от последнего hedge (общее изменение с момента последнего hedge)
      const priceChangeSinceLastHedge = Math.abs((currentPrice - hedgeInfo.lastHedgePrice) / hedgeInfo.lastHedgePrice * 100);
      
      // Изменение с момента последней проверки (для накопления)
      const lastCheckedPrice = hedgeInfo.lastCheckedPrice || hedgeInfo.lastHedgePrice;
      const priceChangeSinceLastCheck = Math.abs((currentPrice - lastCheckedPrice) / lastCheckedPrice * 100);
      
      // НАКОПЛЕННОЕ изменение с момента последнего hedge (накапливаем только реальные изменения)
      // Накапливаем только если цена реально изменилась с момента последней проверки
      const lastAccumulated = hedgeInfo.accumulatedChangeSinceLastHedge || 0;
      let accumulatedChangeSinceLastHedge: number;
      
      if (priceChangeSinceLastCheck > 0.001) { // Если цена реально изменилась (больше 0.001%)
        // Накапливаем изменение с момента последней проверки
        accumulatedChangeSinceLastHedge = lastAccumulated + priceChangeSinceLastCheck;
        // Обновляем последнюю проверенную цену
        hedgeInfo.lastCheckedPrice = currentPrice;
      } else {
        // Цена не изменилась - не накапливаем
        accumulatedChangeSinceLastHedge = lastAccumulated;
      }
      
      // Используем абсолютное значение для проверки порога
      const accumulatedChangeAbs = accumulatedChangeSinceLastHedge;
      
      // Изменение от последнего hedge недостаточно, но проверим накопленное изменение
      if (priceChangeSinceLastHedge < minPriceChange) {
        // Если накопленное изменение >= значительного порога, делаем hedge
        // Это гарантирует, что даже маленькие изменения (0.05% x 20 = 1%) будут захеджированы
        if (accumulatedChangeAbs >= significantChangeThreshold) {
          console.log(`[BOT] 📊 Accumulated price change reached threshold: ${accumulatedChangeAbs.toFixed(3)}% >= ${significantChangeThreshold}% (current change: ${priceChangeSinceLastHedge.toFixed(3)}%)`);
          // Продолжаем с hedge
        } else {
          console.log(`[BOT] ⏭️ Hedge skipped for position ${position.positionAddress.substring(0, 8)}... - price change too small: ${priceChangeSinceLastHedge.toFixed(3)}% (threshold: ${minPriceChange}%), accumulated: ${accumulatedChangeAbs.toFixed(3)}%`);
          // Обновляем накопленное изменение в hedgeInfo (уже обновлено выше, если цена изменилась)
          hedgeInfo.accumulatedChangeSinceLastHedge = accumulatedChangeSinceLastHedge;
          // Обновляем lastCheckedPrice даже если не делаем hedge (чтобы не накапливать одно и то же изменение повторно)
          if (priceChangeSinceLastCheck <= 0.001) {
            hedgeInfo.lastCheckedPrice = currentPrice; // Обновляем, чтобы не накапливать одно и то же
          }
          return null;
        }
      } else {
        console.log(`[BOT] ✅ Price change sufficient for hedge: ${priceChangeSinceLastHedge.toFixed(3)}% >= ${minPriceChange}%`);
        // Если изменение достаточно, сбрасываем накопленное (будет обновлено после hedge)
        hedgeInfo.accumulatedChangeSinceLastHedge = 0;
        hedgeInfo.lastCheckedPrice = currentPrice; // Обновляем последнюю проверенную цену
      }
    } else {
      // Первый hedge - проверяем изменение от начальной цены
      const priceChangeFromInitial = Math.abs((currentPrice - position.initialPrice) / position.initialPrice) * 100;
      if (priceChangeFromInitial < minPriceChange) {
        console.log(`[BOT] ⏭️ First hedge skipped - price change from initial too small: ${priceChangeFromInitial.toFixed(3)}% (threshold: ${minPriceChange}%)`);
        return null;
      }
    }

    // Рассчитываем hedge amount
    // Используем инкрементальный расчет от последней цены hedge
    const lastHedgePrice = hedgeInfo?.lastHedgePrice || position.initialPrice;
    
    // Логируем накопленное изменение для отладки
    const accumulatedChangeFromInitial = Math.abs((currentPrice - position.initialPrice) / position.initialPrice) * 100;
    const changeSinceLastHedge = hedgeInfo 
      ? Math.abs((currentPrice - lastHedgePrice) / lastHedgePrice) * 100 
      : accumulatedChangeFromInitial;
    const accumulatedChangeSinceLastHedge = hedgeInfo?.accumulatedChangeSinceLastHedge || 0;
    
    console.log(`[BOT] 📊 Hedge calculation for position ${position.positionAddress.substring(0, 8)}...:`, {
      initialPrice: position.initialPrice.toFixed(6),
      lastHedgePrice: lastHedgePrice.toFixed(6),
      currentPrice: currentPrice.toFixed(6),
      changeSinceLastHedge: changeSinceLastHedge.toFixed(3) + '%',
      accumulatedChangeSinceLastHedge: accumulatedChangeSinceLastHedge.toFixed(3) + '%',
      accumulatedChangeFromInitial: accumulatedChangeFromInitial.toFixed(3) + '%',
      hedgeCount: hedgeInfo?.hedgeCount || 0,
    });
    
    const hedge = await this.strategyCalculator.calculateHedgeAmount(
      position,
      currentPrice,
      position.initialPrice,
      config.mirrorSwap.hedgeAmountPercent,
      positionBinData,
      lastHedgePrice, // Передаем последнюю цену для инкрементального расчета
    );

    // Если hedge amount слишком мал, пропускаем
    const minHedgeAmount = config.mirrorSwap.minHedgeAmount ?? 0.001;
    const hedgeAmountNum = parseFloat(hedge.amount);
    if (hedgeAmountNum < minHedgeAmount) {
      console.log(`[BOT] ⏭️ Hedge skipped for position ${position.positionAddress.substring(0, 8)}... - amount too small: ${hedgeAmountNum} (threshold: ${minHedgeAmount})`);
      return null;
    }

    try {
      // Определяем направление swap
      // direction = 'buy': покупаем Token X, продаем Token Y (swap: Y -> X)
      // direction = 'sell': продаем Token X, покупаем Token Y (swap: X -> Y)
      const inputMint = hedge.direction === 'buy' ? position.tokenYMint : position.tokenXMint;
      const outputMint = hedge.direction === 'buy' ? position.tokenXMint : position.tokenYMint;
      
      // Рассчитываем количество input токена в human-readable формате
      // calculateHedgeAmount возвращает:
      // - Для 'sell': количество Token X (в токенах)
      // - Для 'buy': количество Token Y (в USD, нужно конвертировать в токены)
      // Но для swap нам нужно количество input токена:
      // - Для 'buy' (Y -> X): input = Token Y, amount уже в USD, нужно конвертировать в токены Y
      // - Для 'sell' (X -> Y): input = Token X, amount уже в токенах X
      const inputAmountHuman = hedge.direction === 'buy' 
        ? hedgeAmountNum // hedgeAmount уже в USD для Token Y (1 Y = 1 USD для стейблкоинов)
        : hedgeAmountNum; // hedgeAmount уже в Token X

      // Конвертируем в минимальные единицы с учетом decimals
      const { toSmallestUnitsAuto } = await import('../utils/tokenUtils.js');
      const inputAmountInSmallestUnits = await toSmallestUnitsAuto(
        this.connection,
        inputAmountHuman,
        inputMint,
      );

      // Валидация: проверяем, что результат разумен
      // toSmallestUnitsAuto возвращает bigint, конвертируем в строку для точности
      const amountStr = inputAmountInSmallestUnits.toString();
      const amountNum = Number(inputAmountInSmallestUnits);
      
      if (isNaN(amountNum) || amountNum <= 0) {
        console.warn(`Invalid hedge amount calculated: ${amountStr} (from ${inputAmountHuman})`);
        return null;
      }
      
      // Проверяем, что сумма не слишком большая (защита от ошибок расчета)
      // Максимальная разумная сумма для swap: 1e15 (1 квадриллион в минимальных единицах)
      if (amountNum > 1e15) {
        console.error(`Hedge amount too large: ${amountStr}, this is likely a calculation error. Skipping hedge.`);
        return null;
      }

      // Логируем для отладки
      const priceChangeFromInitial = ((currentPrice - position.initialPrice) / position.initialPrice * 100);
      const priceChangeFromLastHedge = hedgeInfo 
        ? ((currentPrice - hedgeInfo.lastHedgePrice) / hedgeInfo.lastHedgePrice * 100)
        : priceChangeFromInitial;
      
      // Рассчитываем стоимость позиции для логирования
      const { StrategyCalculator } = await import('./strategyCalculator.js');
      const calculator = new StrategyCalculator(this.strategyCalculator['priceMonitor']);
      const positionValue = await calculator['estimatePositionValue'](position, currentPrice, positionBinData);
      
      console.log(`[BOT] 🔄 [Hedge] Calculating swap for position ${position.positionAddress.substring(0, 8)}...:`, {
        direction: hedge.direction,
        hedgeRatio: hedge.hedgeRatio?.toFixed(6) || 'N/A',
        hedgeRatioPercent: hedge.hedgeRatio ? (hedge.hedgeRatio * 100).toFixed(4) + '%' : 'N/A',
        inputAmountHuman: inputAmountHuman.toFixed(6),
        inputMint: inputMint.substring(0, 8) + '...',
        outputMint: outputMint.substring(0, 8) + '...',
        amountSmallestUnits: amountStr,
        currentPrice: currentPrice.toFixed(6),
        initialPrice: position.initialPrice.toFixed(6),
        lastHedgePrice: hedgeInfo?.lastHedgePrice?.toFixed(6) || 'N/A',
        basePrice: lastHedgePrice.toFixed(6),
        priceChangeFromInitial: priceChangeFromInitial.toFixed(2) + '%',
        priceChangeFromLastHedge: priceChangeFromLastHedge.toFixed(2) + '%',
        priceChangeRaw: ((lastHedgePrice - currentPrice) / lastHedgePrice * 100).toFixed(4) + '%',
        hedgeAmountPercent: config.mirrorSwap.hedgeAmountPercent + '%',
        positionValueUSD: positionValue.toFixed(2),
        hedgeValueUSD: (positionValue * Math.abs(hedge.hedgeRatio || 0)).toFixed(2),
        formula: `h = ${(config.mirrorSwap.hedgeAmountPercent / 100).toFixed(2)} * (${lastHedgePrice.toFixed(2)} - ${currentPrice.toFixed(2)}) / ${lastHedgePrice.toFixed(2)} = ${hedge.hedgeRatio?.toFixed(6) || 'N/A'}`,
      });

      // Получаем котировку от Jupiter
      const quote = await getQuote({
        inputMint,
        outputMint,
        amount: amountNum, // В минимальных единицах
        slippageBps: config.mirrorSwap.slippageBps,
      });

      if (!quote || !quote.outAmount) {
        console.warn(`No quote available for hedge swap: ${position.positionAddress}`);
        return null;
      }

      // Создаем транзакцию swap
      const swapTx = await createSwapTransaction(
        this.connection,
        this.userKeypair.publicKey,
        quote,
      );

      // Получаем балансы ДО swap для проверки
      let balanceBeforeX = '0';
      let balanceBeforeY = '0';
      try {
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const { getAssociatedTokenAddress } = await import('@solana/spl-token');
        
        // Для Token X: если это native SOL, используем getBalance, иначе getTokenAccountBalance
        if (position.tokenXMint === SOL_MINT) {
          const solBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
          balanceBeforeX = solBalance.toString();
        } else {
          try {
            const tokenXATA = await getAssociatedTokenAddress(new PublicKey(position.tokenXMint), this.userKeypair.publicKey);
            const balanceX = await this.connection.getTokenAccountBalance(tokenXATA, 'confirmed');
            balanceBeforeX = balanceX.value.amount;
          } catch (error: any) {
            // Если токен-аккаунт не существует, баланс = 0
            if (error.message?.includes('could not find account')) {
              balanceBeforeX = '0';
            } else {
              throw error;
            }
          }
        }
        
        // Для Token Y: всегда используем getTokenAccountBalance (USDC и другие токены)
        try {
          const tokenYATA = await getAssociatedTokenAddress(new PublicKey(position.tokenYMint), this.userKeypair.publicKey);
          const balanceY = await this.connection.getTokenAccountBalance(tokenYATA, 'confirmed');
          balanceBeforeY = balanceY.value.amount;
        } catch (error: any) {
          // Если токен-аккаунт не существует, баланс = 0
          if (error.message?.includes('could not find account')) {
            balanceBeforeY = '0';
          } else {
            throw error;
          }
        }
      } catch (error) {
        console.warn(`[BOT] ⚠️ Could not get balances before swap:`, error);
      }

      // Подписываем и отправляем
      const signature = await signAndSend(this.connection, this.userKeypair, swapTx);
      
      // Получаем балансы ПОСЛЕ swap для проверки (с небольшой задержкой)
      let balanceAfterX = '0';
      let balanceAfterY = '0';
      try {
        await new Promise(resolve => setTimeout(resolve, 2000)); // Ждем обновления балансов
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const { getAssociatedTokenAddress } = await import('@solana/spl-token');
        
        // Для Token X: если это native SOL, используем getBalance, иначе getTokenAccountBalance
        if (position.tokenXMint === SOL_MINT) {
          const solBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
          balanceAfterX = solBalance.toString();
        } else {
          try {
            const tokenXATA = await getAssociatedTokenAddress(new PublicKey(position.tokenXMint), this.userKeypair.publicKey);
            const balanceX = await this.connection.getTokenAccountBalance(tokenXATA, 'confirmed');
            balanceAfterX = balanceX.value.amount;
          } catch (error: any) {
            // Если токен-аккаунт не существует, баланс = 0
            if (error.message?.includes('could not find account')) {
              balanceAfterX = '0';
            } else {
              throw error;
            }
          }
        }
        
        // Для Token Y: всегда используем getTokenAccountBalance (USDC и другие токены)
        try {
          const tokenYATA = await getAssociatedTokenAddress(new PublicKey(position.tokenYMint), this.userKeypair.publicKey);
          const balanceY = await this.connection.getTokenAccountBalance(tokenYATA, 'confirmed');
          balanceAfterY = balanceY.value.amount;
        } catch (error: any) {
          // Если токен-аккаунт не существует, баланс = 0
          if (error.message?.includes('could not find account')) {
            balanceAfterY = '0';
          } else {
            throw error;
          }
        }
      } catch (error) {
        console.warn(`[BOT] ⚠️ Could not get balances after swap:`, error);
      }

      // Рассчитываем изменения балансов
      const balanceChangeX = BigInt(balanceAfterX) - BigInt(balanceBeforeX);
      const balanceChangeY = BigInt(balanceAfterY) - BigInt(balanceBeforeY);
      
      // Для валидации учитываем, что комиссия за транзакцию списывается с SOL
      // Для 'buy' (Y -> X): Y должен уменьшиться, X может уменьшиться из-за комиссии или увеличиться
      // Для 'sell' (X -> Y): X должен уменьшиться, Y должен увеличиться
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const isTokenXSOL = position.tokenXMint === SOL_MINT;
      
      let validation: string;
      if (hedge.direction === 'sell') {
        // Продаем X (SOL) за Y (USDC): X должен уменьшиться, Y должен увеличиться
        validation = (balanceChangeX < 0n && balanceChangeY > 0n) ? '✅ CORRECT' : '❌ INCORRECT';
      } else {
        // Покупаем X (SOL) за Y (USDC): Y должен уменьшиться
        // X может уменьшиться из-за комиссии транзакции (если это SOL) или увеличиться
        if (isTokenXSOL) {
          // Если Token X это SOL, комиссия списывается с него, поэтому он может уменьшиться
          // Главное - Y должен уменьшиться (мы потратили USDC)
          validation = balanceChangeY < 0n ? '✅ CORRECT (fee deducted from SOL)' : '❌ INCORRECT';
        } else {
          // Если Token X не SOL, он должен увеличиться
          validation = (balanceChangeY < 0n && balanceChangeX > 0n) ? '✅ CORRECT' : '❌ INCORRECT';
        }
      }
      
      console.log(`[BOT] ✅ Hedge swap EXECUTED for position ${position.positionAddress.substring(0, 8)}...:`, {
        direction: hedge.direction,
        amount: hedge.amount,
        inputMint: inputMint.substring(0, 8) + '...',
        outputMint: outputMint.substring(0, 8) + '...',
        signature: signature,
        currentPrice: currentPrice.toFixed(6),
        quoteOutAmount: quote.outAmount,
        expectedOutAmount: quote.outAmount,
        balanceBefore: {
          tokenX: balanceBeforeX,
          tokenY: balanceBeforeY,
        },
        balanceAfter: {
          tokenX: balanceAfterX,
          tokenY: balanceAfterY,
        },
        balanceChange: {
          tokenX: balanceChangeX.toString(),
          tokenY: balanceChangeY.toString(),
        },
        validation: validation,
      });

      // Рассчитываем изменение цены от начальной
      const priceChangePercent = position.initialPrice > 0
        ? ((currentPrice - position.initialPrice) / position.initialPrice) * 100
        : 0;

      // Создаем запись о hedge swap
      const hedgeSwapInfo: HedgeSwapInfo = {
        timestamp: Date.now(),
        direction: hedge.direction,
        amount: hedge.amount,
        price: currentPrice,
        priceChangePercent,
        signature,
        inputMint,
        outputMint,
      };

      // Добавляем в историю позиции
      if (!position.hedgeSwapsHistory) {
        position.hedgeSwapsHistory = [];
      }
      position.hedgeSwapsHistory.push(hedgeSwapInfo);
      
      // Ограничиваем историю последними 100 записями
      if (position.hedgeSwapsHistory.length > 100) {
        position.hedgeSwapsHistory = position.hedgeSwapsHistory.slice(-100);
      }

      // Сохраняем обновленную позицию с историей
      this.storage.savePosition(position);

      // Обновляем информацию о последнем hedge
      if (hedgeInfo) {
        hedgeInfo.lastHedgePrice = currentPrice;
        hedgeInfo.lastHedgeAmount = hedge.amount;
        hedgeInfo.lastHedgeDirection = hedge.direction;
        hedgeInfo.hedgeCount = (hedgeInfo.hedgeCount || 0) + 1;
        hedgeInfo.accumulatedChangeSinceLastHedge = 0; // Сбрасываем накопленное изменение после hedge
        hedgeInfo.lastCheckedPrice = currentPrice; // Обновляем последнюю проверенную цену
        
        console.log(`[BOT] ✅ Hedge #${hedgeInfo.hedgeCount} completed for position ${position.positionAddress.substring(0, 8)}...`);
      }

      return signature;
    } catch (error) {
      console.error(`Error executing hedge swap for position ${position.positionAddress}:`, error);
      throw error;
    }
  }

  /**
   * Остановить все hedge swaps
   */
  stopAll(): void {
    for (const [positionAddress] of this.hedgePositions) {
      this.stopHedging(positionAddress);
    }
  }
}

