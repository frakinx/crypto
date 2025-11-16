import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { 
  createOpenPositionTransaction, 
  createClosePositionTransaction,
  getPositionInfo,
  getClaimableSwapFees,
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
    
    // Загружаем сохраненные позиции
    this.loadPositionsFromStorage();
  }
  
  /**
   * Загрузить позиции из хранилища
   */
  private loadPositionsFromStorage(): void {
    const savedPositions = this.storage.getActivePositions();
    for (const position of savedPositions) {
      this.activePositions.set(position.positionAddress, position);
    }
    console.log(`Loaded ${savedPositions.length} positions from storage`);
  }

  /**
   * Открыть новую позицию
   */
  async openPosition(
    poolAddress: string,
    tokenXAmount: string,
    tokenYAmount: string,
    rangeInterval: number,
    config: AdminConfig,
  ): Promise<PositionInfo> {
    // Рассчитываем границы на основе текущей цены и коридора
    const currentPrice = await this.priceMonitor.getPoolPrice(poolAddress);
    const upperBoundPrice = currentPrice * (1 + config.priceCorridorPercent.upper / 100);
    const lowerBoundPrice = currentPrice * (1 - config.priceCorridorPercent.lower / 100);

    // Создаем транзакцию открытия позиции с retry
    const result = await executeWithRetry(
      () => createOpenPositionTransaction(
        this.connection,
        {
          poolAddress,
          userPublicKey: this.userKeypair.publicKey,
          strategy: 'balance',
          rangeInterval,
          tokenXAmount,
          tokenYAmount,
        },
      ),
      { maxRetries: 3, retryDelayMs: 1000 },
    );
    
    const { transaction, positionKeypair } = result;

    // Подписываем и отправляем транзакцию с retry логикой
    const signature = await executeWithRetry(
      () => signAndSend(this.connection, this.userKeypair, transaction),
      { maxRetries: 3, retryDelayMs: 2000 },
    );
    console.log(`Position opened: ${positionKeypair.publicKey.toBase58()}, signature: ${signature}`);

    // Получаем информацию о пуле для mint адресов
    const dlmmPool = await createDlmmPool(this.connection, poolAddress);
    const tokenXMint = (dlmmPool.lbPair as any).tokenXMint.toBase58();
    const tokenYMint = (dlmmPool.lbPair as any).tokenYMint.toBase58();
    
    // Получаем bin IDs из активного bin и rangeInterval
    const activeBin = await dlmmPool.getActiveBin();
    const minBinId = activeBin.binId - rangeInterval;
    const maxBinId = activeBin.binId + rangeInterval;

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
      status: 'active',
      openedAt: Date.now(),
      lastPriceCheck: Date.now(),
      currentPrice: currentPrice,
      accumulatedFees: 0,
    };

    // Сохраняем позицию
    this.activePositions.set(position.positionAddress, position);
    this.storage.savePosition(position);

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

    // Импортируем retry логику
    const { executeWithRetry } = await import('./retry.js');

    // Создаем транзакцию закрытия с retry
    const transaction = await executeWithRetry(
      () => createClosePositionTransaction(
        this.connection,
        position.poolAddress,
        positionAddress,
        this.userKeypair.publicKey,
      ),
      { maxRetries: 3, retryDelayMs: 1000 },
    );

    // Подписываем и отправляем с retry
    const signature = await executeWithRetry(
      () => signAndSend(this.connection, this.userKeypair, transaction),
      { maxRetries: 3, retryDelayMs: 2000 },
    );
    
    console.log(`Position closed: ${positionAddress}, reason: ${reason}, signature: ${signature}`);

    // Обновляем статус
    position.status = 'closed';
    position.closedAt = Date.now();
    this.storage.savePosition(position);
    this.activePositions.delete(positionAddress);

    return signature;
  }

  /**
   * Принять решение по позиции на основе текущей цены и стратегии
   */
  async makeDecision(
    position: PositionInfo,
    config: AdminConfig,
  ): Promise<PositionDecision> {
    // Обновляем цену
    const priceUpdate = await this.priceMonitor.updatePositionPrice(position);
    position.currentPrice = priceUpdate.price;
    position.lastPriceCheck = Date.now();
    
    // Сохраняем обновленную позицию
    this.storage.savePosition(position);

    // Проверяем пробитие потолка - открываем новую позицию выше
    if (this.priceMonitor.isPriceAboveUpperBound(position, priceUpdate.price)) {
      const newLowerBound = priceUpdate.price * (1 - config.priceCorridorPercent.lower / 100);
      const newUpperBound = priceUpdate.price * (1 + config.priceCorridorPercent.upper / 100);

      return {
        action: 'open_new',
        reason: `Price above upper bound - opening new position above`,
        positionAddress: position.positionAddress,
        newPositionParams: {
          poolAddress: position.poolAddress,
          lowerBoundPrice: newLowerBound,
          upperBoundPrice: newUpperBound,
        },
      };
    }

    // Проверяем пробитие пола - открываем новую позицию ниже
    if (this.priceMonitor.isPriceBelowLowerBound(position, priceUpdate.price)) {
      const newLowerBound = priceUpdate.price * (1 - config.priceCorridorPercent.lower / 100);
      const newUpperBound = priceUpdate.price * (1 + config.priceCorridorPercent.upper / 100);

      return {
        action: 'open_new',
        reason: `Price below lower bound - opening new position below`,
        positionAddress: position.positionAddress,
        newPositionParams: {
          poolAddress: position.poolAddress,
          lowerBoundPrice: newLowerBound,
          upperBoundPrice: newUpperBound,
        },
      };
    }

    // Если цена падает (но еще в пределах границ)
    if (priceUpdate.price < position.initialPrice) {
      // Проверяем, достигли ли мы уровня для проверки fee
      const pricePositionPercent = this.priceMonitor.getPricePositionPercent(
        position,
        priceUpdate.price,
      );

      if (pricePositionPercent <= config.feeCheckPercent) {
        // Получаем реальные данные о комиссиях из API
        const feesData = await this.strategyCalculator.getRealAccumulatedFeesFromAPI(
          position.poolAddress,
          position.positionAddress,
        );
        
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
        
        // Рассчитываем накопленные комиссии
        const timeInPoolHours = (Date.now() - position.openedAt) / (1000 * 60 * 60);
        const positionLiquidityPercent = 1; // TODO: рассчитать на основе реальной ликвидности
        
        const accumulatedFees = this.strategyCalculator.calculateAccumulatedFees(
          position,
          feesData.poolVolume24h,
          feesData.poolFeeBps,
          positionLiquidityPercent,
          timeInPoolHours,
        );
        
        // Обновляем накопленные комиссии в позиции
        position.accumulatedFees = accumulatedFees;

        // Рассчитываем, перекрывают ли fee потери (используем реальное распределение по bins)
        const calculation = await this.strategyCalculator.calculateFeeVsLoss(
          position,
          priceUpdate.price,
          config.stopLossPercent,
          accumulatedFees,
          positionBinData,
        );

        if (calculation.shouldClose) {
          // Fee перекрывают потери - закрываем по SL
          return {
            action: 'close',
            reason: `Fees ($${calculation.accumulatedFees.toFixed(2)}) cover losses ($${calculation.estimatedLoss.toFixed(2)})`,
            positionAddress: position.positionAddress,
          };
        } else {
          // Fee не перекрывают потери - оставляем позицию и открываем новую ниже
          const newLowerBound = priceUpdate.price * (1 - config.priceCorridorPercent.lower / 100);
          const newUpperBound = priceUpdate.price * (1 + config.priceCorridorPercent.upper / 100);

          return {
            action: 'open_new',
            reason: `Fees ($${calculation.accumulatedFees.toFixed(2)}) don't cover losses ($${calculation.estimatedLoss.toFixed(2)}) - opening new position below`,
            positionAddress: position.positionAddress,
            newPositionParams: {
              poolAddress: position.poolAddress,
              lowerBoundPrice: newLowerBound,
              upperBoundPrice: newUpperBound,
            },
          };
        }
      }
    }

    // Проверяем нижнюю границу (stop loss)
    if (this.priceMonitor.isPriceBelowLowerBound(position, priceUpdate.price)) {
      return {
        action: 'close',
        reason: 'Price below lower bound (stop loss)',
        positionAddress: position.positionAddress,
      };
    }

    // Никаких действий не требуется
    return {
      action: 'none',
      reason: 'Price within bounds, no action needed',
      positionAddress: position.positionAddress,
    };
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
}

