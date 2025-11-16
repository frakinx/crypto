import { PublicKey } from '@solana/web3.js';

/**
 * Типы для системы мониторинга позиций
 */

export type PositionStatus = 'active' | 'closed' | 'pending_close' | 'stop_loss' | 'take_profit';

export type PositionInfo = {
  // Идентификаторы
  positionAddress: string; // Адрес позиции (PublicKey)
  poolAddress: string; // Адрес пула
  userAddress: string; // Адрес пользователя
  
  // Параметры позиции
  tokenXMint: string;
  tokenYMint: string;
  initialTokenXAmount: string; // Начальное количество Token X
  initialTokenYAmount: string; // Начальное количество Token Y
  initialPrice: number; // Цена при открытии позиции
  
  // Границы позиции
  upperBoundPrice: number; // Верхняя граница цены (take profit)
  lowerBoundPrice: number; // Нижняя граница цены (stop loss)
  
  // Bin IDs
  minBinId: number;
  maxBinId: number;
  
  // Статус и метаданные
  status: PositionStatus;
  openedAt: number; // Timestamp открытия
  closedAt?: number; // Timestamp закрытия
  
  // Мониторинг
  lastPriceCheck: number; // Последняя проверка цены
  currentPrice?: number; // Текущая цена
  accumulatedFees?: number; // Накопленные комиссии в USD
  
  // Для Mirror Swapping
  hedgePosition?: {
    hedgeAmount: string; // Количество для хеджирования
    hedgeTransaction?: string; // Транзакция хеджирования
  };
};

export type PriceUpdate = {
  poolAddress: string;
  price: number; // Текущая цена
  timestamp: number;
  priceChangePercent: number; // Изменение цены в процентах от начальной
};

export type PositionDecision = {
  action: 'close' | 'keep' | 'open_new' | 'hedge' | 'none';
  reason: string;
  positionAddress: string;
  newPositionParams?: {
    poolAddress: string;
    lowerBoundPrice: number;
    upperBoundPrice: number;
  };
};

export type FeeVsLossCalculation = {
  accumulatedFees: number; // Накопленные комиссии в USD
  estimatedLoss: number; // Оценка потерь при закрытии на SL
  netResult: number; // Чистый результат (fees - losses)
  shouldClose: boolean; // Следует ли закрывать позицию
  breakEvenPrice: number; // Цена безубыточности
};

