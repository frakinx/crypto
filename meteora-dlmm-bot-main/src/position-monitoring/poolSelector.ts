import { Connection } from '@solana/web3.js';
import { fetchDlmmPairs } from '../dex/meteora.js';
import { PriceMonitor } from './priceMonitor.js';
import type { AdminConfig } from './config.js';
import type { DlmmPair } from '../dex/meteora.js';

/**
 * Модуль автоподбора пула
 * На основе параметров админа (коридор в процентах) подбирает подходящий пул
 */

export class PoolSelector {
  private connection: Connection;
  private priceMonitor: PriceMonitor;

  constructor(connection: Connection, priceMonitor: PriceMonitor) {
    this.connection = connection;
    this.priceMonitor = priceMonitor;
  }

  /**
   * Найти подходящий пул на основе конфигурации админа
   * 
   * @param tokenXMint - Mint адрес базового токена
   * @param tokenYMint - Mint адрес котируемого токена (обычно USDC или SOL)
   * @param config - Конфигурация админа
   * @param currentPrice - Текущая цена (опционально, если не указана - будет получена)
   */
  async findSuitablePool(
    tokenXMint: string,
    tokenYMint: string,
    config: AdminConfig,
    currentPrice?: number,
  ): Promise<DlmmPair | null> {
    // Получаем все пулы
    const allPools = await fetchDlmmPairs();

    // Фильтруем по токенам
    const matchingPools = allPools.filter(pool => {
      const matchesX = pool.tokenXMint === tokenXMint || pool.tokenYMint === tokenXMint;
      const matchesY = pool.tokenXMint === tokenYMint || pool.tokenYMint === tokenYMint;
      return matchesX && matchesY;
    });

    if (matchingPools.length === 0) {
      console.warn(`No pools found for ${tokenXMint}/${tokenYMint}`);
      return null;
    }

    // Оцениваем каждый пул
    const scoredPools = await Promise.all(
      matchingPools.map(async pool => {
        try {
          const score = await this.scorePool(pool, config, currentPrice);
          return { pool, score };
        } catch (error) {
          console.error(`Error scoring pool ${pool.address}:`, error);
          return { pool, score: 0 };
        }
      }),
    );

    // Сортируем по score и возвращаем лучший
    scoredPools.sort((a, b) => b.score - a.score);
    const bestPool = scoredPools[0];

    if (!bestPool || bestPool.score === 0) {
      return null;
    }

    console.log(`Selected pool: ${bestPool.pool.address} with score: ${bestPool.score}`);
    return bestPool.pool;
  }

  /**
   * Оценить пул по критериям
   */
  private async scorePool(
    pool: DlmmPair,
    config: AdminConfig,
    currentPrice?: number,
  ): Promise<number> {
    let score = 0;

    try {
      // Получаем данные о пуле из API
      const poolData = await this.getPoolData(pool.address);

      // Проверяем минимальную ликвидность
      const liquidity = parseFloat(poolData.liquidity || '0');
      if (liquidity < config.poolSelection.minLiquidity) {
        return 0; // Пул не подходит
      }
      score += (liquidity / config.poolSelection.minLiquidity) * 10; // Бонус за ликвидность

      // Проверяем минимальный объем
      const volume24h = parseFloat(poolData.trade_volume_24h || '0');
      if (volume24h < config.poolSelection.minVolume24h) {
        return 0; // Пул не подходит
      }
      score += (volume24h / config.poolSelection.minVolume24h) * 10; // Бонус за объем

      // Проверяем bin step (если указан предпочтительный)
      if (config.poolSelection.preferredBinStep) {
        if (pool.binStep === config.poolSelection.preferredBinStep) {
          score += 20; // Бонус за предпочтительный bin step
        }
      }

      // Проверяем, что цена находится в допустимом диапазоне
      if (currentPrice) {
        const poolPrice = await this.priceMonitor.getPoolPrice(pool.address);
        const priceDiff = Math.abs((poolPrice - currentPrice) / currentPrice) * 100;
        
        // Если цена сильно отличается, снижаем score
        if (priceDiff > 5) {
          score *= 0.5; // Штраф за большую разницу в цене
        }
      }

      // Бонус за комиссию (чем выше комиссия, тем лучше для LP)
      const feeBps = pool.baseFeeBps || 0;
      score += feeBps / 10; // Бонус за комиссию

    } catch (error) {
      console.error(`Error scoring pool ${pool.address}:`, error);
      return 0;
    }

    return score;
  }

  /**
   * Получить данные о пуле из API
   */
  private async getPoolData(poolAddress: string): Promise<any> {
    try {
      const response = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch pool data: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`Error fetching pool data for ${poolAddress}:`, error);
      return {};
    }
  }

  /**
   * Найти пул для новой позиции ниже текущей
   * Используется когда нужно открыть новую позицию при падении цены
   */
  async findPoolForNewPosition(
    tokenXMint: string,
    tokenYMint: string,
    targetPrice: number,
    config: AdminConfig,
  ): Promise<DlmmPair | null> {
    // Ищем пул с ценой близкой к targetPrice
    return this.findSuitablePool(tokenXMint, tokenYMint, config, targetPrice);
  }
}

