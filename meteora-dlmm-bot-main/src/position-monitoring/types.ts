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
  rangeInterval: number; // Количество бинов с каждой стороны (используется для открытия новых позиций)
  
  // Статус и метаданные
  status: PositionStatus;
  openedAt: number; // Timestamp открытия
  closedAt?: number; // Timestamp закрытия
  
  // Мониторинг
  lastPriceCheck: number; // Последняя проверка цены
  currentPrice?: number; // Текущая цена
  accumulatedFees?: number; // Накопленные комиссии в USD
  waitingForAveragePriceClose?: boolean; // Флаг: позиция ждет возврата к средней цене после пробития нижней границы
  
  // Для Mirror Swapping
  hedgePosition?: {
    hedgeAmount: string; // Количество для хеджирования
    hedgeTransaction?: string; // Транзакция хеджирования
  };
  hedgeSwapsHistory?: HedgeSwapInfo[]; // История всех hedge swaps
};

export type HedgeSwapInfo = {
  timestamp: number; // Время выполнения swap
  direction: 'buy' | 'sell'; // Направление swap
  amount: string; // Количество токенов
  price: number; // Цена в момент swap
  priceChangePercent: number; // Изменение цены от начальной
  signature: string; // Signature транзакции
  inputMint: string; // Input токен
  outputMint: string; // Output токен
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
    rangeInterval: number; // Используем rangeInterval из старой позиции
  };
  shouldCloseOld?: boolean; // Флаг для закрытия старой позиции перед открытием новой
};

export type FeeVsLossCalculation = {
  accumulatedFees: number; // Накопленные комиссии в USD
  estimatedLoss: number; // Оценка потерь при закрытии на SL
  netResult: number; // Чистый результат (fees - losses)
  shouldClose: boolean; // Следует ли закрывать позицию
  breakEvenPrice: number; // Цена безубыточности
};

