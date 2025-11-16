import { Connection, PublicKey } from '@solana/web3.js';
import { createDlmmPool } from '../dex/meteora.js';
import { getQuote } from '../dex/jupiter.js';
import { CONFIG } from '../config.js';
import type { PriceUpdate, PositionInfo } from './types.js';

/**
 * Модуль мониторинга цены для позиций
 * Отслеживает изменения цены в пулах и обновляет информацию о позициях
 */

export class PriceMonitor {
  private connection: Connection;
  private priceCache: Map<string, { price: number; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 10000; // 10 секунд

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Получить текущую цену пула
   */
  async getPoolPrice(poolAddress: string): Promise<number> {
    // Проверяем кэш
    const cached = this.priceCache.get(poolAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.price;
    }

    try {
      const dlmmPool = await createDlmmPool(this.connection, poolAddress);
      const activeBin = await dlmmPool.getActiveBin();
      
      // Получаем цену из активного bin
      // Цена в формате: price = (1 + binStep/10000)^binId
      const binStep = (dlmmPool.lbPair as any).binStep;
      const price = this.calculatePriceFromBinId(activeBin.binId, binStep);
      
      // Кэшируем
      this.priceCache.set(poolAddress, {
        price,
        timestamp: Date.now(),
      });
      
      return price;
    } catch (error) {
      console.error(`Error getting price for pool ${poolAddress}:`, error);
      // Возвращаем кэшированное значение если есть
      if (cached) {
        return cached.price;
      }
      throw error;
    }
  }

  /**
   * Рассчитать цену из bin ID
   * Формула: price = (1 + binStep/10000)^binId
   */
  private calculatePriceFromBinId(binId: number, binStep: number): number {
    const base = 1 + binStep / 10000;
    return Math.pow(base, binId);
  }

  /**
   * Получить цену через Jupiter Price API (альтернативный метод)
   */
  async getPriceFromJupiter(tokenMint: string, quoteMint: string = 'So11111111111111111111111111111111111111112'): Promise<number> {
    try {
      const url = `${CONFIG.jup.priceEndpoint}/price?ids=${tokenMint}&vsToken=${quoteMint}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Jupiter price API error: ${response.status}`);
      }
      const data = await response.json();
      const priceData = data.data?.[tokenMint];
      if (!priceData) {
        throw new Error('Price data not found');
      }
      return priceData.price;
    } catch (error) {
      console.error('Error getting price from Jupiter:', error);
      throw error;
    }
  }

  /**
   * Обновить цену для позиции
   */
  async updatePositionPrice(position: PositionInfo): Promise<PriceUpdate> {
    const currentPrice = await this.getPoolPrice(position.poolAddress);
    const priceChangePercent = ((currentPrice - position.initialPrice) / position.initialPrice) * 100;

    return {
      poolAddress: position.poolAddress,
      price: currentPrice,
      timestamp: Date.now(),
      priceChangePercent,
    };
  }

  /**
   * Проверить, пробила ли цена верхний потолок
   */
  isPriceAboveUpperBound(position: PositionInfo, currentPrice: number): boolean {
    return currentPrice >= position.upperBoundPrice;
  }

  /**
   * Проверить, упала ли цена ниже нижней границы
   */
  isPriceBelowLowerBound(position: PositionInfo, currentPrice: number): boolean {
    return currentPrice <= position.lowerBoundPrice;
  }

  /**
   * Проверить, достигла ли цена уровня для проверки fee
   */
  isPriceAtFeeCheckLevel(position: PositionInfo, currentPrice: number, feeCheckPercent: number): boolean {
    // feeCheckPercent - это процент от нижней границы
    // Например, если нижняя граница $96, а feeCheckPercent = 50%,
    // то проверяем на цене $96 + (($100 - $96) * 0.5) = $98
    const priceRange = position.upperBoundPrice - position.lowerBoundPrice;
    const feeCheckPrice = position.lowerBoundPrice + (priceRange * (feeCheckPercent / 100));
    return currentPrice <= feeCheckPrice;
  }

  /**
   * Рассчитать процент от нижней границы, на котором находится текущая цена
   */
  getPricePositionPercent(position: PositionInfo, currentPrice: number): number {
    const priceRange = position.upperBoundPrice - position.lowerBoundPrice;
    if (priceRange === 0) return 0;
    const distanceFromLower = currentPrice - position.lowerBoundPrice;
    return (distanceFromLower / priceRange) * 100;
  }
}

