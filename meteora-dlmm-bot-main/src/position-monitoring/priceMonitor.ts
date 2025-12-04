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
   * Использует API Meteora для получения цены в долларах
   */
  async getPoolPrice(poolAddress: string): Promise<number> {
    // Проверяем кэш
    const cached = this.priceCache.get(poolAddress);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.price;
    }

    try {
      // Сначала пробуем получить цену из API Meteora (правильная цена в долларах)
      const poolResponse = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
      if (poolResponse.ok) {
        const poolData = await poolResponse.json();
        // Пробуем разные варианты названий поля с ценой
        const apiPrice = parseFloat(
          poolData.price || 
          poolData.current_price || 
          poolData.price_usd || 
          '0'
        );
        
        if (apiPrice > 0 && apiPrice > 1) {
          // Используем цену из API, если она выглядит правильной (> 1 для SOL/USDC)
          this.priceCache.set(poolAddress, {
            price: apiPrice,
            timestamp: Date.now(),
          });
          return apiPrice;
        }
      }
    } catch (apiError) {
      console.warn(`Failed to get pool price from API for ${poolAddress}:`, apiError);
    }

    // Fallback: используем activeBin.price (может быть в формате Token X/Token Y)
    try {
      const dlmmPool = await createDlmmPool(this.connection, poolAddress);
      const activeBin = await dlmmPool.getActiveBin();
      
      // Получаем цену из активного bin
      // Цена в формате: price = (1 + binStep/10000)^binId
      const binStep = (dlmmPool.lbPair as any).binStep;
      const binPrice = this.calculatePriceFromBinId(activeBin.binId, binStep);
      
      // Если цена очень маленькая (< 1), возможно это цена в формате Token X/Token Y
      // Для SOL/USDC цена должна быть около 100-200, а не 0.14
      // В этом случае используем как есть, но логируем предупреждение
      if (binPrice > 0 && binPrice < 1) {
        console.warn(`[PriceMonitor] Pool ${poolAddress.substring(0, 8)}... price from bin is ${binPrice}, which seems low. Consider using API price.`);
      }
      
      // Кэшируем
      this.priceCache.set(poolAddress, {
        price: binPrice,
        timestamp: Date.now(),
      });
      
      return binPrice;
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
  calculatePriceFromBinId(binId: number, binStep: number): number {
    const base = 1 + binStep / 10000;
    return Math.pow(base, binId);
  }

  /**
   * Рассчитать границы позиции на основе бинов в долларах
   * ИСПРАВЛЕННЫЙ ПОДХОД: используем прямую формулу из binId: price = (1 + binStep/10000)^binId
   * @param minBinId - минимальный bin ID позиции
   * @param maxBinId - максимальный bin ID позиции
   * @param binStep - bin step пула
   * @param tokenYMint - mint адрес Token Y (для определения, является ли он стейблкоином)
   * @param currentPriceUSD - текущая цена Token X в долларах (используется только для логирования)
   * @returns объект с lowerBoundPrice и upperBoundPrice в долларах
   */
  async calculateBoundsFromBinsUSD(
    minBinId: number, 
    maxBinId: number, 
    binStep: number,
    tokenYMint: string,
    currentPriceUSD: number,
    poolAddress?: string // Опционально: адрес пула для получения активного binId
  ): Promise<{
    lowerBoundPrice: number;
    upperBoundPrice: number;
  }> {
    // ПРАВИЛЬНЫЙ ПОДХОД: Используем активный binId из пула для точного расчета границ
    // Формула Meteora: price = (1 + binStep/10000)^binId
    // Но для конвертации в USD нужно использовать текущую цену из API как референс
    
    let activeBinId: number | null = null;
    let activeBinPriceRaw: number | null = null;
    
    // Получаем активный binId из пула для правильного расчета
    if (poolAddress) {
      try {
        const { createDlmmPool } = await import('../dex/meteora.js');
        const dlmmPool = await createDlmmPool(this.connection, poolAddress);
        const activeBin = await dlmmPool.getActiveBin();
        activeBinId = activeBin.binId;
        
        // Рассчитываем цену активного bin по формуле Meteora
        const base = 1 + binStep / 10000;
        activeBinPriceRaw = Math.pow(base, activeBinId);
        
        console.log(`[PriceMonitor] Active bin info:`, {
          activeBinId,
          activeBinPriceRaw: activeBinPriceRaw.toFixed(8),
          currentPriceUSD: currentPriceUSD.toFixed(6),
          minBinId,
          maxBinId,
        });
      } catch (error) {
        console.warn(`[PriceMonitor] Failed to get active bin from pool:`, error);
      }
    }
    
    // Если получили активный bin, используем его для точного расчета границ
    if (activeBinId !== null && activeBinPriceRaw !== null && activeBinPriceRaw > 0) {
      const base = 1 + binStep / 10000;
      
      // Рассчитываем цены границ по формуле Meteora
      const lowerBoundPriceRaw = Math.pow(base, minBinId);
      const upperBoundPriceRaw = Math.pow(base, maxBinId);
      
      // Определяем коэффициент масштабирования: currentPriceUSD / activeBinPriceRaw
      // Это позволяет конвертировать цены из формата bin в USD
      const scaleFactor = currentPriceUSD / activeBinPriceRaw;
      
      // Применяем масштабирование к границам
      const lowerBoundPrice = lowerBoundPriceRaw * scaleFactor;
      const upperBoundPrice = upperBoundPriceRaw * scaleFactor;
      
      console.log(`[PriceMonitor] Calculated bounds using active bin:`, {
        activeBinId,
        activeBinPriceRaw: activeBinPriceRaw.toFixed(8),
        lowerBoundPriceRaw: lowerBoundPriceRaw.toFixed(8),
        upperBoundPriceRaw: upperBoundPriceRaw.toFixed(8),
        scaleFactor: scaleFactor.toFixed(6),
        lowerBoundPrice: lowerBoundPrice.toFixed(6),
        upperBoundPrice: upperBoundPrice.toFixed(6),
        currentPriceUSD: currentPriceUSD.toFixed(6),
      });
      
      return { lowerBoundPrice, upperBoundPrice };
    }
    
    // Fallback: используем процентное отклонение на основе binStep
    // Каждый bin представляет изменение цены на (binStep / 10000)
    const priceChangePerBin = binStep / 10000;
    
    // Количество bins от активного bin до границ
    // Предполагаем, что активный bin примерно посередине между minBinId и maxBinId
    const midBinId = (minBinId + maxBinId) / 2;
    const binsToLower = midBinId - minBinId;
    const binsToUpper = maxBinId - midBinId;
    
    // Рассчитываем процентное изменение для каждой границы
    const lowerMultiplier = Math.pow(1 + priceChangePerBin, -binsToLower);
    const upperMultiplier = Math.pow(1 + priceChangePerBin, binsToUpper);
    
    // Применяем к текущей цене
    const lowerBoundPrice = currentPriceUSD * lowerMultiplier;
    const upperBoundPrice = currentPriceUSD * upperMultiplier;
    
    console.log(`[PriceMonitor] Calculated bounds using percentage (fallback):`, {
      currentPriceUSD: currentPriceUSD.toFixed(6),
      minBinId,
      maxBinId,
      midBinId,
      binsToLower,
      binsToUpper,
      lowerMultiplier: lowerMultiplier.toFixed(6),
      upperMultiplier: upperMultiplier.toFixed(6),
      lowerBoundPrice: lowerBoundPrice.toFixed(6),
      upperBoundPrice: upperBoundPrice.toFixed(6),
    });
    
    return { lowerBoundPrice, upperBoundPrice };
  }
  
  /**
   * Рассчитать границы позиции на основе бинов (синхронная версия, возвращает в формате Token X/Token Y)
   * @param minBinId - минимальный bin ID позиции
   * @param maxBinId - максимальный bin ID позиции
   * @param binStep - bin step пула
   * @returns объект с lowerBoundPrice и upperBoundPrice в формате Token X/Token Y
   */
  calculateBoundsFromBins(minBinId: number, maxBinId: number, binStep: number): {
    lowerBoundPrice: number;
    upperBoundPrice: number;
  } {
    const lowerBoundPrice = this.calculatePriceFromBinId(minBinId, binStep);
    const upperBoundPrice = this.calculatePriceFromBinId(maxBinId, binStep);
    return { lowerBoundPrice, upperBoundPrice };
  }
  
  /**
   * Получить цену токена в долларах
   */
  private async getTokenPriceUSD(tokenMint: string): Promise<number> {
    try {
      const { CONFIG } = await import('../config.js');
      // Используем Jupiter Price API
      const url = `${CONFIG.jup.priceEndpoint}/price?ids=${tokenMint}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const priceData = data.data?.[tokenMint];
        if (priceData?.price) {
          return parseFloat(priceData.price);
        }
      }
    } catch (error) {
      console.warn(`Failed to get token price for ${tokenMint}:`, error);
    }
    return 0;
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

