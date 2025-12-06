import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { 
  createOpenPositionTransaction, 
  createClosePositionTransaction,
  getPositionInfo,
  getClaimableSwapFees,
  createClaimSwapFeesTransaction,
  createDlmmPool,
} from '../dex/meteora.js';
import { signAndSend } from '../execution/trader.js';
import type { PositionInfo, PositionDecision } from './types.js';
import { PriceMonitor } from './priceMonitor.js';
import { StrategyCalculator } from './strategyCalculator.js';
import type { AdminConfig } from './config.js';
import { PositionStorage } from './storage.js';
import { executeWithRetry } from './retry.js';

/**
 * Модуль управления позициями
 * Открытие, закрытие, мониторинг позиций
 */

export class PositionManager {
  private connection: Connection;
  private userKeypair: Keypair;
  private priceMonitor: PriceMonitor;
  private strategyCalculator: StrategyCalculator;
  private activePositions: Map<string, PositionInfo> = new Map();
  private storage: PositionStorage;

  constructor(
    connection: Connection,
    userKeypair: Keypair,
    priceMonitor: PriceMonitor,
    strategyCalculator: StrategyCalculator,
  ) {
    this.connection = connection;
    this.userKeypair = userKeypair;
    this.priceMonitor = priceMonitor;
    this.strategyCalculator = strategyCalculator;
    this.storage = new PositionStorage();
    
    // Загружаем сохраненные позиции (асинхронно, но не ждем завершения в конструкторе)
    this.loadPositionsFromStorage().catch(error => {
      console.error('[BOT] ⚠️ Error loading positions from storage:', error);
    });
  }
  
  /**
   * Загрузить позиции из хранилища
   */
  private async loadPositionsFromStorage(): Promise<void> {
    const savedPositions = this.storage.getActivePositions();
    console.log(`[BOT] 📂 Загружаем ${savedPositions.length} позиций из базы данных...`);
    
    for (const position of savedPositions) {
      console.log(`[BOT] 📥 Загружена позиция ${position.positionAddress.substring(0, 8)}...`, {
        pool: position.poolAddress.substring(0, 8) + '...',
        rangeInterval: position.rangeInterval,
        currentPrice: position.currentPrice?.toFixed(2) || 'N/A',
        lowerBound: position.lowerBoundPrice?.toFixed(2) || 'N/A',
        upperBound: position.upperBoundPrice?.toFixed(2) || 'N/A',
        status: position.status,
      });
      
      // Восстанавливаем rangeInterval если он отсутствует
      if (!position.rangeInterval || position.rangeInterval <= 0) {
        if (position.minBinId !== undefined && position.maxBinId !== undefined) {
          const numBins = position.maxBinId - position.minBinId + 1;
          position.rangeInterval = Math.floor(numBins / 2);
          console.log(`[BOT] 🔧 Restored rangeInterval for position ${position.positionAddress.substring(0, 8)}...: ${position.rangeInterval} (from ${numBins} bins)`);
          this.storage.savePosition(position);
        } else {
          // Fallback если нет bin IDs
          position.rangeInterval = 10;
          console.warn(`[BOT] ⚠️ Position ${position.positionAddress.substring(0, 8)}... has no bin IDs, using default rangeInterval: 10`);
        }
      }
      
      // ОДНОРАЗОВОЕ исправление границ для старых позиций (только если границы в неправильном формате)
      // Проверяем, нужно ли исправить границы (если они в формате Token X/Token Y вместо USD)
      try {
        const currentPrice = await this.priceMonitor.getPoolPrice(position.poolAddress);
        if (currentPrice > 100 && (position.lowerBoundPrice < 10 || position.upperBoundPrice < 10)) {
          console.log(`[BOT] 🔧 One-time bounds correction for old position ${position.positionAddress.substring(0, 8)}...`);
          await this.updatePositionBoundsFromBins(position, true); // forceUpdate = true для миграции
        }
      } catch (error) {
        // Игнорируем ошибки при проверке цены при загрузке
        console.warn(`[BOT] ⚠️ Could not check price for position ${position.positionAddress.substring(0, 8)}... during load:`, error);
      }
      
      this.activePositions.set(position.positionAddress, position);
    }
    console.log(`[BOT] ✅ Загружено ${savedPositions.length} активных позиций`);
  }

  /**
   * Обновить границы позиции на основе реальных бинов
   * ВАЖНО: Используется ТОЛЬКО для одноразового исправления границ старых позиций при загрузке из хранилища
   * Границы рассчитываются один раз при открытии позиции и НЕ должны обновляться после этого
   * @param position - Позиция для обновления границ
   * @param forceUpdate - Принудительное обновление (только для миграции старых позиций)
   */
  async updatePositionBoundsFromBins(position: PositionInfo, forceUpdate: boolean = false): Promise<void> {
    // Если forceUpdate = false, не обновляем границы (они должны оставаться фиксированными)
    if (!forceUpdate) {
      return;
    }
    
    try {
      const dlmmPool = await createDlmmPool(this.connection, position.poolAddress);
      const binStep = (dlmmPool.lbPair as any).binStep;
      const tokenYMint = (dlmmPool.lbPair as any).tokenYMint.toBase58();
      
      // Получаем текущую цену для конвертации границ в доллары
      const currentPrice = await this.priceMonitor.getPoolPrice(position.poolAddress);
      
      // Пересчитываем границы на основе реальных бинов В ДОЛЛАРАХ
      // Передаем poolAddress для получения активного binId из пула
      const bounds = await this.priceMonitor.calculateBoundsFromBinsUSD(
        position.minBinId,
        position.maxBinId,
        binStep,
        tokenYMint,
        currentPrice,
        position.poolAddress // Передаем poolAddress для правильного расчета границ
      );
      
      // Обновляем границы только при принудительном обновлении (для миграции старых позиций)
      if (forceUpdate) {
        console.log(`[BOT] 🔧 Updating position bounds from bins for ${position.positionAddress.substring(0, 8)}...:`, {
          oldLowerBound: position.lowerBoundPrice.toFixed(6),
          oldUpperBound: position.upperBoundPrice.toFixed(6),
          newLowerBound: bounds.lowerBoundPrice.toFixed(6),
          newUpperBound: bounds.upperBoundPrice.toFixed(6),
          currentPrice: currentPrice.toFixed(6),
          forceUpdate: forceUpdate,
          minBinId: position.minBinId,
          maxBinId: position.maxBinId,
          binStep: binStep,
        });
        
        position.lowerBoundPrice = bounds.lowerBoundPrice;
        position.upperBoundPrice = bounds.upperBoundPrice;
        
        // Восстанавливаем rangeInterval если он отсутствует
        if (!position.rangeInterval || position.rangeInterval <= 0) {
          const numBins = position.maxBinId - position.minBinId + 1;
          position.rangeInterval = Math.floor(numBins / 2);
          console.log(`[BOT] 🔧 Restored rangeInterval for position ${position.positionAddress.substring(0, 8)}...: ${position.rangeInterval} (from ${numBins} bins)`);
        }
        
        this.storage.savePosition(position);
      } else {
        // Даже если границы не изменились, проверяем и восстанавливаем rangeInterval
        if (!position.rangeInterval || position.rangeInterval <= 0) {
          const numBins = position.maxBinId - position.minBinId + 1;
          position.rangeInterval = Math.floor(numBins / 2);
          console.log(`[BOT] 🔧 Restored rangeInterval for position ${position.positionAddress.substring(0, 8)}...: ${position.rangeInterval} (from ${numBins} bins)`);
          this.storage.savePosition(position);
        }
      }
    } catch (error) {
      console.warn(`Failed to update position bounds from bins for ${position.positionAddress}:`, error);
    }
  }

  /**
   * Открыть новую позицию
   */
  async openPosition(
    poolAddress: string,
    tokenXAmount: string,
    tokenYAmount: string,
    rangeInterval: number | undefined,
    config: AdminConfig,
    autoClaim?: { enabled: boolean; thresholdUSD: number },
  ): Promise<PositionInfo> {
    // Валидация и fallback для rangeInterval
    if (!rangeInterval || rangeInterval <= 0 || rangeInterval > 100) {
      console.warn(`[BOT] ⚠️ Invalid rangeInterval: ${rangeInterval}, using default: 10`);
      rangeInterval = 10;
    }
    
    // Получаем информацию о пуле для расчета реальных границ на основе бинов
    const dlmmPool = await createDlmmPool(this.connection, poolAddress);
    const tokenXMint = (dlmmPool.lbPair as any).tokenXMint.toBase58();
    const tokenYMint = (dlmmPool.lbPair as any).tokenYMint.toBase58();
    const binStep = (dlmmPool.lbPair as any).binStep;
    
    // Получаем bin IDs из активного bin и rangeInterval
    // ВАЖНО: Получаем activeBin ОДИН РАЗ и используем его для всех расчетов
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;
    const minBinId = activeBinId - rangeInterval;
    const maxBinId = activeBinId + rangeInterval;
    
    // Рассчитываем цену активного bin напрямую из формулы (как делает Meteora)
    // Это гарантирует, что мы используем ту же цену, что и Meteora
    const base = 1 + binStep / 10000;
    const activeBinPriceRaw = Math.pow(base, activeBinId);
    
    // Получаем текущую цену для initialPrice (в долларах) для отображения
    // Но для расчета границ используем цену активного bin
    const currentPrice = await this.priceMonitor.getPoolPrice(poolAddress);
    
    // Определяем коэффициент масштабирования, если нужно
    let activeBinPriceUSD: number;
    if (activeBinPriceRaw < 1 && currentPrice > 1) {
      // Если цена из bin < 1, а текущая цена > 1, используем коэффициент масштабирования
      const scaleFactor = currentPrice / activeBinPriceRaw;
      activeBinPriceUSD = currentPrice; // Используем currentPrice как референс
    } else {
      activeBinPriceUSD = activeBinPriceRaw;
    }
    
    // Рассчитываем границы относительно цены активного bin (как делает Meteora)
    // Используем ТОТ ЖЕ activeBinId, что был при открытии позиции
    const lowerBinDiff = minBinId - activeBinId;
    const upperBinDiff = maxBinId - activeBinId;
    
    // Рассчитываем границы как относительное изменение от цены активного bin
    // Формула: newPrice = activeBinPrice * (1 + binStep/10000)^binDiff
    let lowerBoundPrice = activeBinPriceUSD * Math.pow(base, lowerBinDiff);
    let upperBoundPrice = activeBinPriceUSD * Math.pow(base, upperBinDiff);
    
    // Если цены получились < 1, а должны быть в долларах, масштабируем
    if (lowerBoundPrice < 1 && currentPrice > 1) {
      const scaleFactor = currentPrice / activeBinPriceRaw;
      lowerBoundPrice = lowerBoundPrice * scaleFactor;
      upperBoundPrice = upperBoundPrice * scaleFactor;
    }
    
    console.log(`[BOT] Calculated bounds using activeBin:`, {
      activeBinId,
      minBinId,
      maxBinId,
      binStep,
      activeBinPriceRaw: activeBinPriceRaw.toFixed(6),
      activeBinPriceUSD: activeBinPriceUSD.toFixed(6),
      currentPrice: currentPrice.toFixed(6),
      lowerBoundPrice: lowerBoundPrice.toFixed(6),
      upperBoundPrice: upperBoundPrice.toFixed(6),
    });

    // Создаем positionKeypair один раз перед retry, чтобы адрес позиции не менялся при повторных попытках
    const positionKeypair = Keypair.generate();
    
    // Создаем функцию для создания и отправки транзакции (для retry с пересозданием при ошибке blockhash)
    const createAndSendTransaction = async (): Promise<string> => {
      // ВАЖНО: При каждой попытке создаем транзакцию заново с свежим blockhash
      // Используем тот же positionKeypair, чтобы адрес позиции не менялся
      const result = await createOpenPositionTransaction(
        this.connection,
        {
          poolAddress,
          userPublicKey: this.userKeypair.publicKey,
          strategy: 'balance',
          rangeInterval,
          tokenXAmount,
          tokenYAmount,
          positionKeypair, // Передаем сохраненный positionKeypair для retry
        },
    );
    
      const { transaction } = result;

    // ВАЖНО: Транзакция открытия позиции должна быть подписана и user keypair, и position keypair
    // Согласно документации Meteora SDK, транзакция должна быть подписана [user, positionKeypair]
    // Подписываем position keypair перед отправкой
    transaction.sign([positionKeypair]);
    
      // Подписываем и отправляем транзакцию
    // signAndSend добавит подпись user keypair (fee payer)
      return await signAndSend(this.connection, this.userKeypair, transaction);
    };
    
    // Отправляем транзакцию с retry логикой
    // При каждой попытке транзакция пересоздается с свежим blockhash
    const signature = await executeWithRetry(
      createAndSendTransaction,
      { maxRetries: 3, retryDelayMs: 2000 },
    );
    console.log(`[BOT] 🆕 Position OPENED:`, {
      positionAddress: positionKeypair.publicKey.toBase58(),
      signature: signature,
      poolAddress: poolAddress.substring(0, 8) + '...',
      tokenXAmount: tokenXAmount,
      tokenYAmount: tokenYAmount,
      rangeInterval: rangeInterval,
      binStep: binStep,
      minBinId: minBinId,
      maxBinId: maxBinId,
      numBins: maxBinId - minBinId + 1,
      initialPrice: currentPrice.toFixed(6),
      upperBound: upperBoundPrice.toFixed(6),
      lowerBound: lowerBoundPrice.toFixed(6),
    });

    // Создаем информацию о позиции
    const position: PositionInfo = {
      positionAddress: positionKeypair.publicKey.toBase58(),
      poolAddress,
      userAddress: this.userKeypair.publicKey.toBase58(),
      tokenXMint,
      tokenYMint,
      initialTokenXAmount: tokenXAmount,
      initialTokenYAmount: tokenYAmount,
      initialPrice: currentPrice,
      upperBoundPrice,
      lowerBoundPrice,
      minBinId,
      maxBinId,
      rangeInterval, // Сохраняем rangeInterval для использования при открытии новых позиций
      status: 'active',
      openedAt: Date.now(),
      lastPriceCheck: Date.now(),
      currentPrice: currentPrice,
      accumulatedFees: 0,
      autoClaim: autoClaim || undefined,
    };

    // Сохраняем позицию
    this.activePositions.set(position.positionAddress, position);
    this.storage.savePosition(position);

    // Синхронизируем границы с реальными данными из Meteora после открытия
    // Это гарантирует, что границы точно совпадают с тем, что показывает дашборд Meteora
    try {
      const { syncPositionBoundsWithMeteora } = await import('./syncBounds.js');
      const syncedBounds = await syncPositionBoundsWithMeteora(
        this.connection,
        position,
        this.priceMonitor,
      );
      
      if (syncedBounds) {
        // Обновляем позицию с синхронизированными границами
        position.lowerBoundPrice = syncedBounds.lowerBoundPrice;
        position.upperBoundPrice = syncedBounds.upperBoundPrice;
        position.minBinId = syncedBounds.minBinId;
        position.maxBinId = syncedBounds.maxBinId;
        
        // Сохраняем обновленную позицию
        this.activePositions.set(position.positionAddress, position);
        this.storage.savePosition(position);
        
        console.log(`[BOT] ✅ Границы синхронизированы с Meteora для позиции ${position.positionAddress.substring(0, 8)}...`);
      }
    } catch (error) {
      console.warn(`[BOT] ⚠️ Не удалось синхронизировать границы с Meteora для позиции ${position.positionAddress.substring(0, 8)}...:`, error);
      // Продолжаем с рассчитанными границами, если синхронизация не удалась
    }

    return position;
  }

  /**
   * Закрыть позицию с retry логикой
   */
  async closePosition(positionAddress: string, reason: string): Promise<string> {
    const position = this.activePositions.get(positionAddress);
    if (!position) {
      throw new Error(`Position ${positionAddress} not found`);
    }

    // Проверяем, не закрыта ли позиция уже
    if (position.status === 'closed') {
      console.warn(`[BOT] ⚠️ Position ${positionAddress.substring(0, 8)}... is already closed, skipping`);
      return '';
    }

    // Импортируем retry логику
    const { executeWithRetry } = await import('./retry.js');

    // Функция для создания и отправки транзакции закрытия с свежим blockhash
    const createAndSendCloseTransaction = async (): Promise<string> => {
      // Проверяем, не закрыта ли позиция уже, перед созданием транзакции
      try {
        // Получаем poolAddress из позиции
        const position = this.activePositions.get(positionAddress);
        if (!position) {
          throw new Error(`Position ${positionAddress} not found in active positions`);
        }
        await getPositionInfo(this.connection, position.poolAddress, positionAddress, this.userKeypair.publicKey);
        // Позиция существует, продолжаем с закрытием
      } catch (error) {
        const errorMsg = String(error);
        // Если позиция не найдена или уже закрыта, возвращаем пустую строку (успешное закрытие)
        if (errorMsg.includes('not exist') || errorMsg.includes('does not exist') || 
            errorMsg.includes('already been closed') || errorMsg.includes('AccountOwnedByWrongProgram')) {
          console.log(`[BOT] ✅ Position ${positionAddress.substring(0, 8)}... is already closed, no need to close again`);
          return ''; // Возвращаем пустую строку - позиция уже закрыта
        }
        // Другие ошибки пробрасываем дальше (например, проблемы с RPC)
        throw error;
      }
      
      // ВАЖНО: Создаем транзакцию заново при каждой попытке, чтобы получить свежий blockhash
      const transactions = await createClosePositionTransaction(
        this.connection,
        position.poolAddress,
        positionAddress,
        this.userKeypair.publicKey,
      );

      // Обрабатываем массив транзакций или одну транзакцию
      const transactionsArray = Array.isArray(transactions) ? transactions : [transactions];
      let lastSignature = '';

      // Отправляем все транзакции последовательно
      for (const transaction of transactionsArray) {
        const signature = await signAndSend(this.connection, this.userKeypair, transaction);
        lastSignature = signature;
        console.log(`[BOT] Transaction sent for closing position ${positionAddress.substring(0, 8)}...: ${signature.substring(0, 8)}...`);
      }

      return lastSignature;
    };

    // Отправляем транзакцию с retry (при каждой попытке создается новая транзакция с свежим blockhash)
    let lastSignature = '';
    let transactionsCount = 1; // По умолчанию 1 транзакция
    try {
      lastSignature = await executeWithRetry(
        createAndSendCloseTransaction,
        { maxRetries: 3, retryDelayMs: 2000 },
      );
      
      // Получаем количество транзакций из последней попытки
      // Создаем транзакцию еще раз для подсчета (не отправляем)
      try {
        const transactions = await createClosePositionTransaction(
          this.connection,
          position.poolAddress,
          positionAddress,
          this.userKeypair.publicKey,
        );
        transactionsCount = Array.isArray(transactions) ? transactions.length : 1;
      } catch (error) {
        // Игнорируем ошибку при подсчете транзакций
        console.warn(`[BOT] ⚠️ Could not count transactions:`, error);
      }
    } catch (error) {
      const errorMsg = String(error);
      // Если позиция уже закрыта (AccountOwnedByWrongProgram), просто пропускаем
      if (errorMsg.includes('AccountOwnedByWrongProgram') || errorMsg.includes('3007') || errorMsg.includes('already been closed')) {
        console.warn(`[BOT] ⚠️ Position ${positionAddress.substring(0, 8)}... appears to be already closed, skipping`);
        return '';
      }
      throw error;
    }
    
    console.log(`[BOT] 🔒 Position CLOSED:`, {
      positionAddress: positionAddress.substring(0, 8) + '...',
      reason: reason,
      finalSignature: lastSignature,
      transactionsCount: transactionsCount,
    });

    // Останавливаем hedge swap для этой позиции
    try {
      const { HedgeManager } = await import('./hedgeManager.js');
      // Получаем экземпляр hedgeManager из monitor или создаем новый
      // Для простоты, остановим через monitor если он доступен
      const monitor = (this as any).monitor;
      if (monitor?.hedgeManager) {
        monitor.hedgeManager.stopHedging(positionAddress);
      }
    } catch (error) {
      console.warn(`Failed to stop hedging for position ${positionAddress}:`, error);
    }

    // Обновляем статус
    position.status = 'closed';
    position.closedAt = Date.now();
    this.storage.savePosition(position);
    this.activePositions.delete(positionAddress);

    return lastSignature;
  }

  /**
   * Принять решение по позиции на основе текущей цены и стратегии
   */
  async makeDecision(
    position: PositionInfo,
    config: AdminConfig,
  ): Promise<PositionDecision> {
    // ВАЖНО: Границы позиции НЕ должны обновляться после открытия
    // Они рассчитываются один раз при открытии позиции и остаются фиксированными до закрытия
    
    // Убеждаемся, что rangeInterval установлен (только для восстановления, если отсутствует)
    if (!position.rangeInterval || position.rangeInterval <= 0) {
      if (position.minBinId !== undefined && position.maxBinId !== undefined) {
        const numBins = position.maxBinId - position.minBinId + 1;
        position.rangeInterval = Math.floor(numBins / 2);
        console.log(`[BOT] 🔧 Restored rangeInterval in makeDecision for position ${position.positionAddress.substring(0, 8)}...: ${position.rangeInterval}`);
        this.storage.savePosition(position);
      } else {
        position.rangeInterval = 10;
        console.warn(`[BOT] ⚠️ Position ${position.positionAddress.substring(0, 8)}... has no bin IDs in makeDecision, using default rangeInterval: 10`);
      }
    }
    
    // Обновляем цену
    const priceUpdate = await this.priceMonitor.updatePositionPrice(position);
    position.currentPrice = priceUpdate.price;
    position.lastPriceCheck = Date.now();
    
    // Детальное логирование для отладки
    const priceChange = ((priceUpdate.price - position.initialPrice) / position.initialPrice) * 100;
    const pricePositionPercent = this.priceMonitor.getPricePositionPercent(position, priceUpdate.price);
    
    console.log(`[BOT] Position ${position.positionAddress.substring(0, 8)}... check:`, {
      currentPrice: priceUpdate.price.toFixed(6),
      initialPrice: position.initialPrice.toFixed(6),
      priceChange: priceChange.toFixed(2) + '%',
      upperBound: position.upperBoundPrice.toFixed(6),
      lowerBound: position.lowerBoundPrice.toFixed(6),
      pricePositionPercent: pricePositionPercent.toFixed(2) + '%',
      status: position.status,
    });
    
    // Сохраняем обновленную позицию
    this.storage.savePosition(position);

    // Проверяем пробитие потолка - закрываем позицию при пробитии верхней границы изначального диапазона
    // upperBoundPrice - это верхняя граница позиции, рассчитанная при открытии на основе rangeInterval
    if (this.priceMonitor.isPriceAboveUpperBound(position, priceUpdate.price)) {
      console.log(`[BOT] ⬆️ TAKE PROFIT triggered for position ${position.positionAddress.substring(0, 8)}...:`, {
        currentPrice: priceUpdate.price.toFixed(6),
        initialPrice: position.initialPrice.toFixed(6),
        upperBound: position.upperBoundPrice.toFixed(6),
        lowerBound: position.lowerBoundPrice.toFixed(6),
        priceChange: ((priceUpdate.price - position.initialPrice) / position.initialPrice * 100).toFixed(2) + '%',
        rangeInterval: position.rangeInterval,
      });

      return {
        action: 'open_new',
        reason: `Price above upper bound (${position.upperBoundPrice.toFixed(6)}) - closing position and opening new one above`,
        positionAddress: position.positionAddress,
        newPositionParams: {
          poolAddress: position.poolAddress,
          rangeInterval: position.rangeInterval, // Используем тот же rangeInterval
          direction: 'above', // Открываем новую позицию ВЫШЕ текущей цены
        },
      };
    }

    // Проверяем уровень feeCheckPercent - проверка fee vs loss на промежуточном уровне
    // Выполняется ДО пробития нижней границы, если цена достигла уровня feeCheckPercent
    if (!this.priceMonitor.isPriceBelowLowerBound(position, priceUpdate.price) && 
        this.priceMonitor.isPriceAtFeeCheckLevel(position, priceUpdate.price, config.feeCheckPercent)) {
      
      // Получаем реальное распределение токенов по bins из позиции
      let positionBinData: Array<{ binId: number; amountX: any; amountY: any }> | undefined;
      try {
        const { positionData } = await getPositionInfo(
          this.connection,
          position.poolAddress,
          position.positionAddress,
          new PublicKey(position.userAddress),
        );
        positionBinData = (positionData as any)?.positionBinData;
      } catch (error) {
        console.warn(`Failed to get position bin data for ${position.positionAddress}:`, error);
      }
      
      // Получаем РЕАЛЬНЫЕ накопленные комиссии из позиции через SDK
      const accumulatedFees = await this.strategyCalculator.getRealAccumulatedFees(
        this.connection,
        position,
        priceUpdate.price,
      );
      
      // Обновляем накопленные комиссии в позиции
      position.accumulatedFees = accumulatedFees;

      // Рассчитываем, перекрывают ли fee потери
      const calculation = await this.strategyCalculator.calculateFeeVsLoss(
        position,
        priceUpdate.price,
        config.stopLossPercent,
        accumulatedFees,
        positionBinData,
      );

      // Рассчитываем уровень проверки для логирования
      const priceRange = position.upperBoundPrice - position.lowerBoundPrice;
      const feeCheckPrice = position.lowerBoundPrice + (priceRange * (config.feeCheckPercent / 100));

      console.log(`[BOT] 💰 Fee vs Loss check (at ${config.feeCheckPercent}% level) for position ${position.positionAddress.substring(0, 8)}...:`, {
        accumulatedFees: `$${calculation.accumulatedFees.toFixed(2)}`,
        estimatedLoss: `$${calculation.estimatedLoss.toFixed(2)}`,
        netResult: `$${calculation.netResult.toFixed(2)}`,
        shouldClose: calculation.shouldClose,
        currentPrice: priceUpdate.price.toFixed(6),
        feeCheckPrice: feeCheckPrice.toFixed(6),
        lowerBound: position.lowerBoundPrice.toFixed(6),
        stopLossPrice: (position.lowerBoundPrice * (1 + config.stopLossPercent / 100)).toFixed(6),
      });

      // Если комиссии перекрывают потери → закрываем позицию сразу
      if (calculation.shouldClose) {
        console.log(`[BOT] ✅ Closing position ${position.positionAddress.substring(0, 8)}... - fees cover losses at ${config.feeCheckPercent}% level`);
        return {
          action: 'close',
          reason: `Fees ($${calculation.accumulatedFees.toFixed(2)}) cover losses ($${calculation.estimatedLoss.toFixed(2)}) at ${config.feeCheckPercent}% level`,
          positionAddress: position.positionAddress,
        };
      }
      // Если комиссии НЕ перекрывают потери → продолжаем мониторинг (не закрываем)
      // Позиция останется открытой до пробития нижней границы
    }

    // Проверяем пробитие пола - проверяем fee vs loss перед принятием решения
    if (this.priceMonitor.isPriceBelowLowerBound(position, priceUpdate.price)) {
      console.log(`[BOT] ⬇️ STOP LOSS triggered for position ${position.positionAddress.substring(0, 8)}...:`, {
        currentPrice: priceUpdate.price.toFixed(6),
        lowerBound: position.lowerBoundPrice.toFixed(6),
        rangeInterval: position.rangeInterval,
      });
      
      // Получаем реальное распределение токенов по bins из позиции
      let positionBinData: Array<{ binId: number; amountX: any; amountY: any }> | undefined;
      try {
        const { positionData } = await getPositionInfo(
          this.connection,
          position.poolAddress,
          position.positionAddress,
          new PublicKey(position.userAddress),
        );
        positionBinData = (positionData as any)?.positionBinData;
      } catch (error) {
        console.warn(`Failed to get position bin data for ${position.positionAddress}:`, error);
      }
      
      // Получаем РЕАЛЬНЫЕ накопленные комиссии из позиции через SDK
      // Это реальные claimable fees, а не теоретический расчет
      const accumulatedFees = await this.strategyCalculator.getRealAccumulatedFees(
        this.connection,
        position,
        priceUpdate.price,
      );
      
      // Обновляем накопленные комиссии в позиции
      position.accumulatedFees = accumulatedFees;

      // Рассчитываем, перекрывают ли fee потери
      const calculation = await this.strategyCalculator.calculateFeeVsLoss(
        position,
        priceUpdate.price,
        config.stopLossPercent,
        accumulatedFees,
        positionBinData,
      );

      console.log(`[BOT] 💰 Fee vs Loss check (lower bound breached) for position ${position.positionAddress.substring(0, 8)}...:`, {
        accumulatedFees: `$${calculation.accumulatedFees.toFixed(2)}`,
        estimatedLoss: `$${calculation.estimatedLoss.toFixed(2)}`,
        netResult: `$${calculation.netResult.toFixed(2)}`,
        shouldClose: calculation.shouldClose,
        currentPrice: priceUpdate.price.toFixed(6),
        stopLossPrice: (position.lowerBoundPrice * (1 + config.stopLossPercent / 100)).toFixed(6),
      });

      // Если комиссии ≥ потерь → закрываем позицию сразу при пробитии нижней границы и открываем новую ниже
      if (calculation.shouldClose) {
        console.log(`[BOT] ✅ Fees cover losses - closing position ${position.positionAddress.substring(0, 8)}... and opening new one below`);
        return {
          action: 'open_new',
          reason: `Fees ($${calculation.accumulatedFees.toFixed(2)}) cover losses ($${calculation.estimatedLoss.toFixed(2)}) - closing at lower bound and opening new position below`,
          positionAddress: position.positionAddress,
          newPositionParams: {
            poolAddress: position.poolAddress,
            rangeInterval: position.rangeInterval,
            direction: 'below', // Открываем новую позицию НИЖЕ текущей цены
          },
        };
      } else {
        // Комиссии < потерь → закрываем позицию и открываем новую ниже
        console.log(`[BOT] 📍 Fees don't cover losses - closing position and opening new one below`);
        return {
          action: 'open_new',
          reason: `Fees ($${calculation.accumulatedFees.toFixed(2)}) don't cover losses ($${calculation.estimatedLoss.toFixed(2)}) - closing and opening new position below`,
          positionAddress: position.positionAddress,
          newPositionParams: {
            poolAddress: position.poolAddress,
            rangeInterval: position.rangeInterval,
            direction: 'below', // Открываем новую позицию НИЖЕ текущей цены
          },
        };
      }
    }

    // Никаких действий не требуется
    return {
      action: 'none',
      reason: 'Price within bounds, no action needed',
      positionAddress: position.positionAddress,
    };
  }

  /**
   * Синхронизировать позиции из хранилища (загрузить новые и обновить существующие)
   */
  async syncPositionsFromStorage(): Promise<void> {
    const savedPositions = this.storage.getActivePositions();
    const savedPositionsMap = new Map(savedPositions.map(p => [p.positionAddress, p]));
    
    // Проверяем статус позиций на Meteora (блокчейне)
    const METEORA_DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');
    
    for (const [address, position] of savedPositionsMap) {
      try {
        const accountInfo = await this.connection.getAccountInfo(
          new PublicKey(address),
          'confirmed'
        );
        
        if (!accountInfo) {
          // Позиция не существует на блокчейне - закрыта
          console.log(`[BOT] 🔍 Position ${address.substring(0, 8)}... not found on-chain, marking as closed`);
          position.status = 'closed';
          position.closedAt = Date.now();
          this.storage.savePosition(position);
          savedPositionsMap.delete(address);
          continue;
        }
        
        // Проверяем владельца аккаунта
        if (!accountInfo.owner.equals(METEORA_DLMM_PROGRAM_ID)) {
          // Позиция закрыта (аккаунт принадлежит System Program или другому программе)
          console.log(`[BOT] 🔍 Position ${address.substring(0, 8)}... is closed on-chain (owner: ${accountInfo.owner.toBase58().substring(0, 8)}...), marking as closed`);
          position.status = 'closed';
          position.closedAt = Date.now();
          this.storage.savePosition(position);
          savedPositionsMap.delete(address);
          continue;
        }
      } catch (error) {
        console.warn(`[BOT] ⚠️ Could not check position ${address.substring(0, 8)}... status on-chain:`, error);
        // Продолжаем, если не можем проверить статус
      }
    }
    
    // Находим новые позиции
    const newPositions = Array.from(savedPositionsMap.keys()).filter(
      address => !this.activePositions.has(address)
    );
    
    if (newPositions.length > 0) {
      console.log(`[BOT] 🔄 Синхронизация: найдено ${newPositions.length} новых позиций`);
    }
    
    // Добавляем новые позиции и обновляем существующие
    for (const [address, position] of savedPositionsMap) {
      const isNew = !this.activePositions.has(address);
      
      if (isNew) {
        console.log(`[BOT] 🆕 Новая позиция ${position.positionAddress.substring(0, 8)}... синхронизирована из базы данных`, {
          pool: position.poolAddress.substring(0, 8) + '...',
          rangeInterval: position.rangeInterval,
          currentPrice: position.currentPrice?.toFixed(2) || 'N/A',
          lowerBound: position.lowerBoundPrice?.toFixed(2) || 'N/A',
          upperBound: position.upperBoundPrice?.toFixed(2) || 'N/A',
        });
      }
      
      // Восстанавливаем rangeInterval если он отсутствует
      if (!position.rangeInterval || position.rangeInterval <= 0) {
        if (position.minBinId !== undefined && position.maxBinId !== undefined) {
          const numBins = position.maxBinId - position.minBinId + 1;
          position.rangeInterval = Math.floor(numBins / 2);
          console.log(`[BOT] 🔧 Restored rangeInterval for position ${position.positionAddress.substring(0, 8)}...: ${position.rangeInterval} (from ${numBins} bins)`);
          this.storage.savePosition(position);
        } else {
          // Fallback если нет bin IDs
          position.rangeInterval = 10;
          console.warn(`[BOT] ⚠️ Position ${position.positionAddress.substring(0, 8)}... has no bin IDs, using default rangeInterval: 10`);
        }
      }
      this.activePositions.set(address, position);
    }
    
    // Удаляем позиции, которых больше нет в хранилище или они неактивны
    for (const [address, position] of this.activePositions) {
      if (!savedPositionsMap.has(address) || position.status !== 'active') {
        this.activePositions.delete(address);
      }
    }
  }

  /**
   * Получить все активные позиции
   */
  getActivePositions(): PositionInfo[] {
    return Array.from(this.activePositions.values()).filter(p => p.status === 'active');
  }

  /**
   * Получить позицию по адресу
   */
  getPosition(positionAddress: string): PositionInfo | undefined {
    return this.activePositions.get(positionAddress);
  }

  /**
   * Добавить позицию в мониторинг
   */
  addPosition(position: PositionInfo): void {
    this.activePositions.set(position.positionAddress, position);
  }

  /**
   * Удалить позицию из мониторинга
   */
  removePosition(positionAddress: string): void {
    this.activePositions.delete(positionAddress);
  }

  /**
   * Клейм комиссий из позиции
   */
  async claimFees(positionAddress: string): Promise<string> {
    const position = this.activePositions.get(positionAddress);
    if (!position) {
      throw new Error(`Position ${positionAddress} not found`);
    }

    if (position.status !== 'active') {
      throw new Error(`Position ${positionAddress} is not active`);
    }

    console.log(`[BOT] 💰 Claiming fees for position ${positionAddress.substring(0, 8)}...`);

    const claimTx = await createClaimSwapFeesTransaction(
      this.connection,
      position.poolAddress,
      position.positionAddress,
      new PublicKey(position.userAddress),
    );

    const signature = await signAndSend(this.connection, this.userKeypair, claimTx);
    
    // Обновляем время последнего клейма
    position.lastClaimAt = Date.now();
    this.storage.savePosition(position);

    console.log(`[BOT] ✅ Fees claimed successfully: ${signature}`);
    return signature;
  }
}

