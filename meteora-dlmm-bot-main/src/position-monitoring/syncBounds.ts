import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { createDlmmPool, getPositionInfo } from '../dex/meteora.js';
import type { PositionInfo } from './types.js';
import { PriceMonitor } from './priceMonitor.js';

/**
 * Синхронизировать границы цены позиции с реальными данными из Meteora
 * Получает реальные minBinId и maxBinId из позиции и пересчитывает границы
 */
export async function syncPositionBoundsWithMeteora(
  connection: Connection,
  position: PositionInfo,
  priceMonitor: PriceMonitor,
): Promise<{ lowerBoundPrice: number; upperBoundPrice: number; minBinId: number; maxBinId: number } | null> {
  try {
    console.log(`[BOT] 🔄 Синхронизация границ с Meteora для позиции ${position.positionAddress.substring(0, 8)}...`);
    
    // Ждем немного, чтобы позиция была доступна в Meteora
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Получаем реальные данные позиции из Meteora
    const { positionData, activeBin } = await getPositionInfo(
      connection,
      position.poolAddress,
      position.positionAddress,
      new PublicKey(position.userAddress),
    );
    
    // Извлекаем реальные bin IDs из positionBinData
    const positionBinData = (positionData as any)?.positionBinData || [];
    
    if (!positionBinData || positionBinData.length === 0) {
      console.warn(`[BOT] ⚠️ Не найдены данные о bins в позиции ${position.positionAddress.substring(0, 8)}...`);
      return null;
    }
    
    // Получаем все bin IDs из позиции
    const binIds = positionBinData
      .map((bin: any) => {
        if (!bin || bin.binId === undefined || bin.binId === null) {
          return null;
        }
        
        // Конвертируем binId в число
        if (bin.binId instanceof BN || (bin.binId && typeof bin.binId.toNumber === 'function')) {
          try {
            return bin.binId.toNumber();
          } catch (e) {
            return null;
          }
        }
        
        if (typeof bin.binId === 'number') {
          return bin.binId;
        }
        
        const numId = Number(bin.binId);
        return isNaN(numId) ? null : numId;
      })
      .filter((id: number | null): id is number => id !== null && typeof id === 'number');
    
    if (binIds.length === 0) {
      console.warn(`[BOT] ⚠️ Не найдены валидные bin IDs в позиции ${position.positionAddress.substring(0, 8)}...`);
      return null;
    }
    
    // Получаем реальные minBinId и maxBinId
    const realMinBinId = Math.min(...binIds);
    const realMaxBinId = Math.max(...binIds);
    
    console.log(`[BOT] 📊 Реальные bin IDs из Meteora:`, {
      minBinId: realMinBinId,
      maxBinId: realMaxBinId,
      totalBins: binIds.length,
      calculatedMinBinId: position.minBinId,
      calculatedMaxBinId: position.maxBinId,
    });
    
    // Получаем данные пула для расчета границ
    const dlmmPool = await createDlmmPool(connection, position.poolAddress);
    const binStep = (dlmmPool.lbPair as any)?.binStep || 1;
    
    // Получаем текущую цену для расчета границ
    const currentPrice = await priceMonitor.getPoolPrice(position.poolAddress);
    
    // Используем активный binId для расчета границ
    const activeBinId = activeBin?.binId;
    
    if (!activeBinId) {
      console.warn(`[BOT] ⚠️ Не найден активный binId для пула ${position.poolAddress.substring(0, 8)}...`);
      return null;
    }
    
    // Рассчитываем границы на основе реальных bin IDs
    const base = 1 + binStep / 10000;
    const activeBinPriceRaw = Math.pow(base, activeBinId);
    
    // Определяем коэффициент масштабирования, если нужно
    let activeBinPriceUSD: number;
    if (activeBinPriceRaw < 1 && currentPrice > 1) {
      const scaleFactor = currentPrice / activeBinPriceRaw;
      activeBinPriceUSD = currentPrice;
    } else {
      activeBinPriceUSD = activeBinPriceRaw;
    }
    
    // Рассчитываем границы относительно цены активного bin (как делает Meteora)
    const lowerBinDiff = realMinBinId - activeBinId;
    const upperBinDiff = realMaxBinId - activeBinId;
    
    let lowerBoundPrice = activeBinPriceUSD * Math.pow(base, lowerBinDiff);
    let upperBoundPrice = activeBinPriceUSD * Math.pow(base, upperBinDiff);
    
    // Если цены получились < 1, а должны быть в долларах, масштабируем
    if (lowerBoundPrice < 1 && currentPrice > 1) {
      const scaleFactor = currentPrice / activeBinPriceRaw;
      lowerBoundPrice = lowerBoundPrice * scaleFactor;
      upperBoundPrice = upperBoundPrice * scaleFactor;
    }
    
    console.log(`[BOT] ✅ Синхронизированные границы из Meteora:`, {
      oldLowerBound: position.lowerBoundPrice.toFixed(6),
      oldUpperBound: position.upperBoundPrice.toFixed(6),
      newLowerBound: lowerBoundPrice.toFixed(6),
      newUpperBound: upperBoundPrice.toFixed(6),
      oldMinBinId: position.minBinId,
      oldMaxBinId: position.maxBinId,
      newMinBinId: realMinBinId,
      newMaxBinId: realMaxBinId,
      activeBinId,
      currentPrice: currentPrice.toFixed(6),
    });
    
    return {
      lowerBoundPrice,
      upperBoundPrice,
      minBinId: realMinBinId,
      maxBinId: realMaxBinId,
    };
  } catch (error) {
    console.error(`[BOT] ❌ Ошибка синхронизации границ с Meteora для позиции ${position.positionAddress.substring(0, 8)}...:`, error);
    return null;
  }
}

