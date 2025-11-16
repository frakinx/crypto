import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import { getQuote, createSwapTransaction } from '../dex/jupiter.js';
import { signAndSend } from '../execution/trader.js';
import { CONFIG } from '../config.js';
import type { PositionInfo } from './types.js';
import type { AdminConfig } from './config.js';
import { StrategyCalculator } from './strategyCalculator.js';

/**
 * Модуль управления hedge swap для Mirror Swapping стратегии
 * Выполняет постоянные hedge swaps от открытия позиции до ее закрытия
 */

export class HedgeManager {
  private connection: Connection;
  private userKeypair: Keypair;
  private strategyCalculator: StrategyCalculator;
  private hedgePositions: Map<string, {
    lastHedgePrice: number;
    lastHedgeAmount: string;
    lastHedgeDirection: 'buy' | 'sell';
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
    // Hedge выполняется при каждом изменении цены
    // Для этого нужно отслеживать изменения цены в мониторе
    // Пока делаем периодическую проверку
    const hedgeInterval = setInterval(async () => {
      try {
        await this.executeHedge(position, config, positionBinData);
      } catch (error) {
        console.error(`Error in periodic hedge for position ${position.positionAddress}:`, error);
      }
    }, config.monitoring.priceUpdateIntervalMs);

    this.hedgePositions.set(position.positionAddress, {
      lastHedgePrice: position.initialPrice,
      lastHedgeAmount: '0',
      lastHedgeDirection: 'buy',
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
    if (!config.mirrorSwap.enabled) {
      return null;
    }

    const currentPrice = position.currentPrice || position.initialPrice;
    const hedgeInfo = this.hedgePositions.get(position.positionAddress);
    
    // Проверяем, изменилась ли цена достаточно для нового hedge
    if (hedgeInfo) {
      const priceChange = Math.abs((currentPrice - hedgeInfo.lastHedgePrice) / hedgeInfo.lastHedgePrice) * 100;
      // Если изменение цены меньше 0.1%, не делаем hedge
      if (priceChange < 0.1) {
        return null;
      }
    }

    // Рассчитываем hedge amount
    const hedge = await this.strategyCalculator.calculateHedgeAmount(
      position,
      currentPrice,
      position.initialPrice,
      config.mirrorSwap.hedgeAmountPercent,
      positionBinData,
    );

    // Если hedge amount слишком мал, пропускаем
    const hedgeAmountNum = parseFloat(hedge.amount);
    if (hedgeAmountNum < 0.001) {
      return null;
    }

    try {
      // Определяем направление swap
      // Если нужно покупать (hedge direction = 'buy'), делаем swap: quote -> base
      // Если нужно продавать (hedge direction = 'sell'), делаем swap: base -> quote
      const inputMint = hedge.direction === 'buy' ? position.tokenYMint : position.tokenXMint;
      const outputMint = hedge.direction === 'buy' ? position.tokenXMint : position.tokenYMint;
      
      // Рассчитываем количество input токена
      // Для покупки: используем quote token (Y), для продажи: используем base token (X)
      const inputAmount = hedge.direction === 'buy' 
        ? hedgeAmountNum * currentPrice // Конвертируем в quote token
        : hedgeAmountNum; // Используем base token напрямую

      // Получаем котировку от Jupiter
      const quote = await getQuote({
        inputMint,
        outputMint,
        amount: Math.floor(inputAmount),
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

      // Подписываем и отправляем
      const signature = await signAndSend(this.connection, this.userKeypair, swapTx);
      
      console.log(`Hedge swap executed for position ${position.positionAddress}: ${hedge.direction} ${hedge.amount}, signature: ${signature}`);

      // Обновляем информацию о последнем hedge
      if (hedgeInfo) {
        hedgeInfo.lastHedgePrice = currentPrice;
        hedgeInfo.lastHedgeAmount = hedge.amount;
        hedgeInfo.lastHedgeDirection = hedge.direction;
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

