/**
 * Конфигурация админа для мониторинга и управления позициями
 * 
 * Админ указывает коридор в процентах выше и ниже текущей цены,
 * на основе этих параметров идет автоподбор пула и управление позициями
 */

export type AdminConfig = {
  // Коридор в процентах от текущей цены
  priceCorridorPercent: {
    upper: number; // Процент выше текущей цены (например, 4%)
    lower: number; // Процент ниже текущей цены (например, 4%)
  };
  
  // Параметры для расчета автозакрытия
  stopLossPercent: number; // Stop loss в процентах от нижней границы (например, -2%)
  feeCheckPercent: number; // Процент от нижней границы для проверки fee (например, 50% от нижней границы)
  
  // Параметры для take profit
  takeProfitPercent: number; // Take profit в процентах (например, ±2%)
  
  // Параметры для автоподбора пула
  poolSelection: {
    minLiquidity: number; // Минимальная ликвидность в USD
    minVolume24h: number; // Минимальный объем за 24ч в USD
    preferredBinStep?: number; // Предпочтительный bin step (опционально)
  };
  
  // Параметры мониторинга
  monitoring: {
    checkIntervalMs: number; // Интервал проверки позиций в миллисекундах (например, 30000 = 30 сек)
    priceUpdateIntervalMs: number; // Интервал обновления цены (например, 10000 = 10 сек)
  };
  
  // Параметры для Mirror Swapping стратегии
  mirrorSwap: {
    enabled: boolean; // Включить Mirror Swapping для хеджирования
    hedgeAmountPercent: number; // Процент от позиции для хеджирования (например, 50%)
    slippageBps: number; // Slippage для hedge swap в basis points (например, 100 = 1%)
  };
  
  // Средняя цена для закрытия позиций
  averagePriceClose: {
    enabled: boolean; // Включить закрытие по достижении средней цены
    percentDeviation: number; // Отклонение от средней цены в процентах (например, ±2%)
  };
};

// Конфигурация по умолчанию
export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  priceCorridorPercent: {
    upper: 4, // 4% выше текущей цены
    lower: 4, // 4% ниже текущей цены
  },
  stopLossPercent: -2, // -2% от нижней границы
  feeCheckPercent: 50, // Проверка на 50% от нижней границы
  takeProfitPercent: 2, // ±2% для TP
  poolSelection: {
    minLiquidity: 10000, // Минимум $10k ликвидности
    minVolume24h: 5000, // Минимум $5k объема за 24ч
  },
  monitoring: {
    checkIntervalMs: 30000, // Проверка каждые 30 секунд
    priceUpdateIntervalMs: 10000, // Обновление цены каждые 10 секунд
  },
  mirrorSwap: {
    enabled: true,
    hedgeAmountPercent: 50, // Хеджируем 50% позиции
    slippageBps: 100, // 1% slippage для hedge swap
  },
  averagePriceClose: {
    enabled: true,
    percentDeviation: 2, // ±2% от средней цены
  },
};

/**
 * Загрузка конфигурации админа из файла или переменных окружения
 */
export function loadAdminConfig(): AdminConfig {
  // TODO: Загрузить из файла или БД
  // Пока возвращаем конфигурацию по умолчанию
  return { ...DEFAULT_ADMIN_CONFIG };
}

/**
 * Сохранение конфигурации админа
 */
export function saveAdminConfig(config: AdminConfig): void {
  // TODO: Сохранить в файл или БД
  console.log('Admin config saved:', config);
}

/**
 * Тип для настроек конкретного пула (упрощенная версия AdminConfig)
 */
export type PoolConfig = {
  priceCorridorPercent: {
    upper: number;
    lower: number;
  };
  stopLossPercent: number;
  feeCheckPercent: number;
  takeProfitPercent: number;
  mirrorSwap: {
    enabled: boolean;
    hedgeAmountPercent: number;
    slippageBps: number;
  };
  averagePriceClose: {
    enabled: boolean;
    percentDeviation: number;
  };
};

// Хранилище настроек по пулам (в памяти, можно заменить на БД)
const poolConfigs: Map<string, PoolConfig> = new Map();

/**
 * Получить настройки для конкретного пула
 */
export function getPoolConfig(poolAddress: string): PoolConfig | null {
  return poolConfigs.get(poolAddress) || null;
}

/**
 * Сохранить настройки для конкретного пула
 */
export function savePoolConfig(poolAddress: string, config: PoolConfig): void {
  poolConfigs.set(poolAddress, { ...config });
  console.log(`Pool config saved for ${poolAddress}:`, config);
}

/**
 * Получить настройки пула или использовать настройки по умолчанию
 */
export function getPoolConfigOrDefault(poolAddress: string): PoolConfig {
  const poolConfig = getPoolConfig(poolAddress);
  if (poolConfig) {
    return poolConfig;
  }
  
  // Возвращаем упрощенную версию дефолтной конфигурации
  return {
    priceCorridorPercent: DEFAULT_ADMIN_CONFIG.priceCorridorPercent,
    stopLossPercent: DEFAULT_ADMIN_CONFIG.stopLossPercent,
    feeCheckPercent: DEFAULT_ADMIN_CONFIG.feeCheckPercent,
    takeProfitPercent: DEFAULT_ADMIN_CONFIG.takeProfitPercent,
    mirrorSwap: DEFAULT_ADMIN_CONFIG.mirrorSwap,
    averagePriceClose: DEFAULT_ADMIN_CONFIG.averagePriceClose,
  };
}

/**
 * Получить все настройки пулов
 */
export function getAllPoolConfigs(): Record<string, PoolConfig> {
  const result: Record<string, PoolConfig> = {};
  poolConfigs.forEach((config, address) => {
    result[address] = config;
  });
  return result;
}

