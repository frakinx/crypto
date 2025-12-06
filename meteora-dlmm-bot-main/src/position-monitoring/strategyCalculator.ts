import type { PositionInfo, FeeVsLossCalculation } from './types.js';
import { PriceMonitor } from './priceMonitor.js';
import type { Connection } from '@solana/web3.js';

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

    const finalEstimatedLoss = Math.max(0, estimatedLoss); // Потери не могут быть отрицательными
    
    // Логируем для отладки
    if (finalEstimatedLoss === 0 && accumulatedFees > 0) {
      console.log(`[FeeVsLoss] Position ${position.positionAddress}: No losses detected (currentValue: $${currentValue.toFixed(2)}, slValue: $${slValue.toFixed(2)}, currentPrice: $${currentPrice.toFixed(6)}, stopLossPrice: $${stopLossPrice.toFixed(6)}), keeping position open`);
    }
    
    return {
      accumulatedFees,
      estimatedLoss: finalEstimatedLoss,
      netResult,
      // Закрываем только если есть реальные потери И комиссии их перекрывают
      // Не закрываем позицию, если потерь нет (estimatedLoss = 0)
      shouldClose: finalEstimatedLoss > 0 && netResult >= 0,
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
    const { Connection } = await import('@solana/web3.js');
    const { fromSmallestUnitsAuto } = await import('../utils/tokenUtils.js');
    
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
      
      // Если bins пустые (totalX = 0 и totalY = 0), используем fallback на initialTokenXAmount
      // Это может происходить если позиция только что создана или getPositionBinData вернул неправильные данные
      if (totalX === 0 && totalY === 0) {
        console.warn(`[BOT] [EstimateValue] Position ${position.positionAddress.substring(0, 8)}... has empty bins, using fallback on initialTokenXAmount`);
        // Переходим к fallback ниже
      } else {
        // Конвертируем из минимальных единиц в human-readable с учетом decimals
        // Получаем connection из priceMonitor
        const connection = (this.priceMonitor as any).connection;
        const tokenXHuman = await fromSmallestUnitsAuto(connection, totalX.toString(), position.tokenXMint);
        const tokenYHuman = await fromSmallestUnitsAuto(connection, totalY.toString(), position.tokenYMint);
        
        // Рассчитываем стоимость: X токены * цена + Y токены (в USD, т.к. Token Y обычно стейблкоин)
        const tokenXValue = tokenXHuman * price;
        const tokenYValue = tokenYHuman;
        
        console.log(`[BOT] [EstimateValue] Position value from binData:`, {
          totalXRaw: totalX.toString(),
          totalYRaw: totalY.toString(),
          tokenXHuman: tokenXHuman.toFixed(8),
          tokenYHuman: tokenYHuman.toFixed(8),
          price: price.toFixed(2),
          tokenXValue: tokenXValue.toFixed(2),
          tokenYValue: tokenYValue.toFixed(2),
          totalValue: (tokenXValue + tokenYValue).toFixed(2),
        });
        
        return tokenXValue + tokenYValue;
      }
    }
    
    // Fallback: используем начальные суммы из позиции (они уже в минимальных единицах)
    // ВАЖНО: initialTokenXAmount и initialTokenYAmount хранятся в минимальных единицах
    // Конвертируем в human-readable с учетом decimals
    const connection = (this.priceMonitor as any).connection;
    const tokenXHuman = await fromSmallestUnitsAuto(
      connection,
      position.initialTokenXAmount,
      position.tokenXMint,
    );
    const tokenYHuman = await fromSmallestUnitsAuto(
      connection,
      position.initialTokenYAmount,
      position.tokenYMint,
    );
    
    const tokenXValue = tokenXHuman * price;
    const tokenYValue = tokenYHuman; // Token Y обычно стейблкоин (1 USDC = $1)
    
    console.log(`[BOT] [EstimateValue] Position value from initial amounts:`, {
      initialXRaw: position.initialTokenXAmount,
      initialYRaw: position.initialTokenYAmount,
      tokenXHuman: tokenXHuman.toFixed(8),
      tokenYHuman: tokenYHuman.toFixed(8),
      price: price.toFixed(2),
      tokenXValue: tokenXValue.toFixed(2),
      tokenYValue: tokenYValue.toFixed(2),
      totalValue: (tokenXValue + tokenYValue).toFixed(2),
    });
    
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
   * Использует getClaimableSwapFees для получения реальных комиссий
   */
  async getRealAccumulatedFees(
    connection: Connection,
    position: PositionInfo,
    currentPrice?: number,
  ): Promise<number> {
    try {
      const { getClaimableSwapFees } = await import('../dex/meteora.js');
      const { fromSmallestUnitsAuto } = await import('../utils/tokenUtils.js');
      const { PublicKey } = await import('@solana/web3.js');
      
      // Получаем реальные комиссии из позиции
      const claimableFees = await getClaimableSwapFees(
        connection,
        position.poolAddress,
        position.positionAddress,
        new PublicKey(position.userAddress),
      );
      
      // Логируем для отладки
      console.log(`[BOT] [Fees] Claimable fees for position ${position.positionAddress.substring(0, 8)}...:`, {
        tokenX: claimableFees.tokenX.toString(),
        tokenY: claimableFees.tokenY.toString(),
        tokenXMint: position.tokenXMint.substring(0, 8) + '...',
        tokenYMint: position.tokenYMint.substring(0, 8) + '...',
      });
      
      // Конвертируем комиссии в human-readable формат
      const feeXAmount = await fromSmallestUnitsAuto(
        connection,
        claimableFees.tokenX.toString(),
        position.tokenXMint,
      );
      const feeYAmount = await fromSmallestUnitsAuto(
        connection,
        claimableFees.tokenY.toString(),
        position.tokenYMint,
      );
      
      console.log(`[BOT] [Fees] Converted fees:`, {
        feeXAmount: feeXAmount.toFixed(8),
        feeYAmount: feeYAmount.toFixed(8),
      });
      
      // Получаем текущую цену для конвертации в USD
      // Если цена не передана, получаем её из priceMonitor
      let price = currentPrice;
      if (!price) {
        price = await this.priceMonitor.getPoolPrice(position.poolAddress);
      }
      
      // Конвертируем комиссии в USD
      // Token X * цена + Token Y (предполагаем, что Token Y - стейблкоин в USD)
      // Для стейблкоинов (USDC/USDT) 1 токен = 1 USD
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
      
      let feeXUSD = 0;
      let feeYUSD = 0;
      
      // Token X: если это SOL, умножаем на цену, иначе считаем что это уже в USD
      if (position.tokenXMint === SOL_MINT) {
        feeXUSD = feeXAmount * price;
      } else if (position.tokenXMint === USDC_MINT || position.tokenXMint === USDT_MINT) {
        feeXUSD = feeXAmount; // Стейблкоины: 1 токен = 1 USD
      } else {
        // Для других токенов используем цену пула (цена Token X в USD)
        feeXUSD = feeXAmount * price;
      }
      
      // Token Y: обычно стейблкоин, но проверяем
      if (position.tokenYMint === SOL_MINT) {
        feeYUSD = feeYAmount * price;
      } else if (position.tokenYMint === USDC_MINT || position.tokenYMint === USDT_MINT) {
        feeYUSD = feeYAmount; // Стейблкоины: 1 токен = 1 USD
      } else {
        // Для других токенов считаем что это quote токен (обычно стейблкоин)
        feeYUSD = feeYAmount;
      }
      
      const totalFeesUSD = feeXUSD + feeYUSD;
      
      console.log(`[BOT] [Fees] Total fees in USD:`, {
        feeXUSD: feeXUSD.toFixed(6),
        feeYUSD: feeYUSD.toFixed(6),
        totalFeesUSD: totalFeesUSD.toFixed(6),
        currentPrice: price.toFixed(6),
      });
      
      return Math.max(0, totalFeesUSD);
    } catch (error) {
      console.warn(`[BOT] ⚠️ Failed to get real accumulated fees for position ${position.positionAddress.substring(0, 8)}...:`, error);
      // При ошибке возвращаем 0 вместо теоретического расчета
      return 0;
    }
  }

  /**
   * Рассчитать hedge amount для Mirror Swapping стратегии
   * Формула из презентации: h = 0.5 · (P₀ − P)/P₀
   * 
   * ВАЖНО: Эта формула рассчитывает полное хеджирование от начальной цены.
   * Для инкрементального хеджирования нужно учитывать уже выполненные hedge.
   * 
   * @param position - Информация о позиции
   * @param currentPrice - Текущая цена
   * @param initialPrice - Начальная цена (или последняя цена hedge для инкрементального расчета)
   * @param hedgePercent - Процент позиции для хеджирования (применяется к коэффициенту 0.5)
   * @param positionBinData - Реальное распределение токенов по bins (опционально)
   * @param lastHedgePrice - Последняя цена, при которой выполнялся hedge (для инкрементального расчета)
   */
  async calculateHedgeAmount(
    position: PositionInfo,
    currentPrice: number,
    initialPrice: number,
    hedgePercent: number,
    positionBinData?: Array<{ binId: number; amountX: any; amountY: any }>,
    lastHedgePrice?: number,
  ): Promise<{ amount: string; direction: 'buy' | 'sell'; hedgeRatio: number }> {
    // Определяем базовую цену для расчета
    // Если указана lastHedgePrice, используем инкрементальный расчет
    // Иначе используем полный расчет от initialPrice
    const basePrice = lastHedgePrice || initialPrice;
    
    // Формула для полного зеркалирования: h = (P₀ − P)/P₀
    // Применяем hedgePercent: если hedgePercent = 100%, то хеджируем 100% изменения
    // Если hedgePercent = 50%, то хеджируем 50% изменения
    // Для полного зеркалирования (100%) нужно убрать коэффициент 0.5
    const priceChange = (basePrice - currentPrice) / basePrice;
    // При hedgePercent = 100% хеджируем 100% изменения цены (полное зеркалирование)
    // При hedgePercent = 50% хеджируем 50% изменения цены
    const hedgeRatio = (hedgePercent / 100) * priceChange;
    
    // Рассчитываем стоимость позиции при текущей цене
    const positionValue = await this.estimatePositionValue(position, currentPrice, positionBinData);
    
    // Стоимость для хеджирования (в USD)
    const hedgeValueUSD = positionValue * Math.abs(hedgeRatio);
    
    // MIRROR SWAPPING: Делаем ОБРАТНОЕ тому, что делает LP
    // 📉 Когда цена ПАДАЕТ (priceChange > 0, т.е. P < P₀):
    //    - LP автоматически ПРОДАЕТ Token X (SOL) → накапливает Token Y (USDC)
    //    - Мы в кошельке должны КУПИТЬ Token X (SOL) → direction = 'buy'
    // 
    // 📈 Когда цена РАСТЕТ (priceChange < 0, т.е. P > P₀):
    //    - LP автоматически ПОКУПАЕТ Token X (SOL) → тратит Token Y (USDC)
    //    - Мы в кошельке должны ПРОДАТЬ Token X (SOL) → direction = 'sell'
    const direction = priceChange > 0 ? 'buy' : 'sell';
    
    // Рассчитываем количество токена для swap
    // Для 'sell': продаем Token X, количество = hedgeValueUSD / currentPrice
    // Для 'buy': покупаем Token X, продаем Token Y, количество Token Y = hedgeValueUSD
    // ВАЖНО: Предполагаем, что Token Y - стейблкоин (USDC/USDT), где 1 USD = 1 токен
    // Если Token Y не стейблкоин, нужно делить на цену Token Y в USD
    const hedgeAmount = direction === 'sell' 
      ? hedgeValueUSD / currentPrice  // Количество Token X для продажи
      : hedgeValueUSD;                 // Количество Token Y для продажи (предполагаем стейблкоин)
    
    console.log(`[BOT] [HedgeCalculation] Calculated hedge for position ${position.positionAddress.substring(0, 8)}...:`, {
      basePrice: basePrice.toFixed(6),
      currentPrice: currentPrice.toFixed(6),
      priceChange: (priceChange * 100).toFixed(3) + '%',
      hedgePercent: hedgePercent + '%',
      hedgeRatio: (hedgeRatio * 100).toFixed(3) + '%',
      positionValue: positionValue.toFixed(2),
      hedgeValueUSD: hedgeValueUSD.toFixed(6), // Исправлено: показываем больше знаков для маленьких значений
      hedgeValueUSDRaw: hedgeValueUSD, // Добавляем raw значение для отладки
      direction: direction,
      hedgeAmount: hedgeAmount.toFixed(8),
    });
    
    return {
      amount: hedgeAmount.toString(),
      direction,
      hedgeRatio, // Возвращаем для логирования
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

