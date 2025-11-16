import type { PositionInfo, FeeVsLossCalculation } from './types.js';
import { PriceMonitor } from './priceMonitor.js';

/**
 * Модуль расчета стратегии
 * Определяет, перекрывают ли накопленные fee потери от stop loss
 */

export class StrategyCalculator {
  private priceMonitor: PriceMonitor;

  constructor(priceMonitor: PriceMonitor) {
    this.priceMonitor = priceMonitor;
  }

  /**
   * Рассчитать, перекрывают ли fee потери от stop loss
   * 
   * @param position - Информация о позиции
   * @param currentPrice - Текущая цена
   * @param stopLossPercent - Stop loss в процентах от нижней границы (например, -2%)
   * @param accumulatedFees - Накопленные комиссии в USD
   * @param positionBinData - Реальное распределение токенов по bins (опционально)
   */
  async calculateFeeVsLoss(
    position: PositionInfo,
    currentPrice: number,
    stopLossPercent: number,
    accumulatedFees: number,
    positionBinData?: Array<{ binId: number; amountX: any; amountY: any }>,
  ): Promise<FeeVsLossCalculation> {
    // Рассчитываем цену stop loss
    // stopLossPercent - это процент от нижней границы
    // Например, если нижняя граница $96, а stopLossPercent = -2%,
    // то SL цена = $96 * (1 - 0.02) = $94.08
    const stopLossPrice = position.lowerBoundPrice * (1 + stopLossPercent / 100);

    // Оцениваем потери при закрытии на SL
    // Используем реальное распределение по bins если доступно
    const currentValue = await this.estimatePositionValue(position, currentPrice, positionBinData);
    const slValue = await this.estimatePositionValue(position, stopLossPrice, positionBinData);
    const estimatedLoss = currentValue - slValue;

    // Чистый результат
    const netResult = accumulatedFees - estimatedLoss;

    // Рассчитываем цену безубыточности
    const breakEvenPrice = await this.calculateBreakEvenPrice(position, accumulatedFees, positionBinData);

    return {
      accumulatedFees,
      estimatedLoss: Math.max(0, estimatedLoss), // Потери не могут быть отрицательными
      netResult,
      shouldClose: netResult >= 0, // Закрываем, если fee перекрывают потери
      breakEvenPrice,
    };
  }

  /**
   * Оценить стоимость позиции при заданной цене
   * Использует реальное распределение токенов по bins из позиции
   */
  async estimatePositionValue(
    position: PositionInfo,
    price: number,
    positionBinData?: Array<{ binId: number; amountX: any; amountY: any }>,
  ): Promise<number> {
    // Если есть реальные данные о распределении по bins, используем их
    if (positionBinData && positionBinData.length > 0) {
      let totalX = 0;
      let totalY = 0;
      
      for (const bin of positionBinData) {
        // Конвертируем BN в число
        const xAmount = typeof bin.amountX === 'object' && bin.amountX?.toString 
          ? parseFloat(bin.amountX.toString()) 
          : parseFloat(bin.amountX || '0');
        const yAmount = typeof bin.amountY === 'object' && bin.amountY?.toString 
          ? parseFloat(bin.amountY.toString()) 
          : parseFloat(bin.amountY || '0');
        
        totalX += xAmount;
        totalY += yAmount;
      }
      
      // Рассчитываем стоимость: X токены * цена + Y токены
      // Нужно учесть decimals токенов, но для упрощения используем как есть
      const tokenXValue = totalX * price;
      const tokenYValue = totalY;
      
      return tokenXValue + tokenYValue;
    }
    
    // Fallback: упрощенная модель
    const tokenXValue = parseFloat(position.initialTokenXAmount) * price;
    const tokenYValue = parseFloat(position.initialTokenYAmount);
    
    return tokenXValue + tokenYValue;
  }
  
  /**
   * Синхронная версия для обратной совместимости
   */
  private estimatePositionValueSync(position: PositionInfo, price: number): number {
    const tokenXValue = parseFloat(position.initialTokenXAmount) * price;
    const tokenYValue = parseFloat(position.initialTokenYAmount);
    return tokenXValue + tokenYValue;
  }

  /**
   * Рассчитать цену безубыточности
   */
  private async calculateBreakEvenPrice(
    position: PositionInfo,
    accumulatedFees: number,
    positionBinData?: Array<{ binId: number; amountX: any; amountY: any }>,
  ): Promise<number> {
    // Цена безубыточности - это цена, при которой потери от IL компенсируются fee
    const initialValue = await this.estimatePositionValue(position, position.initialPrice, positionBinData);
    const breakEvenValue = initialValue - accumulatedFees;
    
    // Решаем уравнение для нахождения цены
    // Упрощенная модель: считаем линейную зависимость
    return position.initialPrice * (breakEvenValue / initialValue);
  }

  /**
   * Рассчитать накопленные комиссии для позиции
   * 
   * @param position - Информация о позиции
   * @param poolVolume24h - Объем торговли за 24ч в USD
   * @param poolFeeBps - Комиссия пула в basis points
   * @param positionLiquidityPercent - Процент ликвидности позиции от общей ликвидности пула
   * @param timeInPoolHours - Время в пуле в часах
   */
  calculateAccumulatedFees(
    position: PositionInfo,
    poolVolume24h: number,
    poolFeeBps: number,
    positionLiquidityPercent: number,
    timeInPoolHours: number,
  ): number {
    // Рассчитываем комиссии, которые получила позиция
    // Комиссии распределяются пропорционально ликвидности
    const feePercent = poolFeeBps / 10000; // Конвертируем bps в проценты
    const dailyFees = poolVolume24h * feePercent * (positionLiquidityPercent / 100);
    const accumulatedFees = dailyFees * (timeInPoolHours / 24);
    
    return Math.max(0, accumulatedFees); // Комиссии не могут быть отрицательными
  }
  
  /**
   * Получить реальные накопленные комиссии из позиции через SDK
   * TODO: Реализовать получение реальных данных через getClaimableSwapFees
   */
  async getRealAccumulatedFees(
    connection: any,
    position: PositionInfo,
  ): Promise<number> {
    // TODO: Использовать getClaimableSwapFees из meteora.ts
    // Пока возвращаем 0, нужно реализовать конвертацию в USD
    return 0;
  }

  /**
   * Рассчитать hedge amount для Mirror Swapping стратегии
   * Формула из презентации: h = 0.5 · (P₀ − P)/P₀
   * 
   * @param position - Информация о позиции
   * @param currentPrice - Текущая цена
   * @param initialPrice - Начальная цена
   * @param hedgePercent - Процент позиции для хеджирования
   * @param positionBinData - Реальное распределение токенов по bins (опционально)
   */
  async calculateHedgeAmount(
    position: PositionInfo,
    currentPrice: number,
    initialPrice: number,
    hedgePercent: number,
    positionBinData?: Array<{ binId: number; amountX: any; amountY: any }>,
  ): Promise<{ amount: string; direction: 'buy' | 'sell' }> {
    // Формула из презентации: h = 0.5 · (P₀ − P)/P₀
    const priceChange = (initialPrice - currentPrice) / initialPrice;
    const hedgeRatio = 0.5 * priceChange;
    
    // Применяем hedgePercent
    const adjustedHedgeRatio = hedgeRatio * (hedgePercent / 100);
    
    // Рассчитываем количество токена для хеджирования
    const positionValue = await this.estimatePositionValue(position, currentPrice, positionBinData);
    const hedgeValue = positionValue * Math.abs(adjustedHedgeRatio);
    const hedgeAmount = hedgeValue / currentPrice;
    
    // Определяем направление: если цена упала (priceChange > 0), нужно покупать (hedge)
    // Если цена выросла (priceChange < 0), нужно продавать
    const direction = priceChange > 0 ? 'buy' : 'sell';
    
    return {
      amount: hedgeAmount.toString(),
      direction,
    };
  }
  
  /**
   * Получить реальные данные о комиссиях из Meteora API
   */
  async getRealAccumulatedFeesFromAPI(
    poolAddress: string,
    positionAddress: string,
  ): Promise<{ feesUSD: number; poolVolume24h: number; poolFeeBps: number; liquidity: number }> {
    try {
      // Получаем данные о пуле из API
      const poolResponse = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`);
      if (!poolResponse.ok) {
        throw new Error(`Failed to fetch pool data: ${poolResponse.status}`);
      }
      const poolData = await poolResponse.json();
      
      // Извлекаем данные о комиссиях и объеме
      const poolVolume24h = parseFloat(poolData.trade_volume_24h || poolData.volume_24h || '0');
      const poolFeeBps = Number(poolData.base_fee_bps || poolData.baseFeeBps || 5);
      const liquidity = parseFloat(poolData.liquidity || poolData.total_liquidity || poolData.tvl || '0');
      
      // TODO: Получить реальные комиссии позиции через SDK getClaimableSwapFees
      // Пока используем упрощенную модель на основе объема и времени
      // В будущем нужно получить реальные claimable fees из позиции
      
      return {
        feesUSD: 0, // Будет рассчитано на основе времени и объема
        poolVolume24h,
        poolFeeBps,
        liquidity,
      };
    } catch (error) {
      console.error('Error getting fees from API:', error);
      return {
        feesUSD: 0,
        poolVolume24h: 0,
        poolFeeBps: 5, // Default
        liquidity: 0,
      };
    }
  }
}

