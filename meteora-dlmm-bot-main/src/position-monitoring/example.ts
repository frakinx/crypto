/**
 * Пример использования модуля мониторинга позиций
 * 
 * Этот файл показывает, как интегрировать мониторинг позиций в основной цикл бота
 */

import { CONFIG } from '../config.js';
import { getConnection } from '../rpc.js';
import { loadKeypairFromEnv } from '../utils/wallet.js';
import { PositionMonitor } from './monitor.js';

/**
 * Пример запуска мониторинга позиций
 */
export async function startPositionMonitoring() {
  console.log('Starting Position Monitoring...');
  
  const connection = getConnection();
  const keypair = loadKeypairFromEnv(CONFIG.secretKey);
  
  // Создаем экземпляр монитора
  const monitor = new PositionMonitor(connection, keypair);
  
  // Запускаем мониторинг
  monitor.start();
  
  console.log('Position monitoring started');
  
  // Можно добавить обработку сигналов для graceful shutdown
  process.on('SIGINT', () => {
    console.log('Stopping position monitoring...');
    monitor.stop();
    process.exit(0);
  });
  
  return monitor;
}

/**
 * Пример открытия позиции с автоподбором пула
 */
export async function openPositionWithAutoPool(
  monitor: PositionMonitor,
  tokenXMint: string,
  tokenYMint: string,
  tokenXAmount: string,
  tokenYAmount: string,
) {
  const connection = getConnection();
  const config = monitor['config']; // Доступ к конфигурации (в реальности нужен публичный метод)
  
  // Находим подходящий пул
  const poolSelector = monitor['poolSelector']; // В реальности нужен публичный метод
  const pool = await poolSelector.findSuitablePool(tokenXMint, tokenYMint, config);
  
  if (!pool) {
    throw new Error('No suitable pool found');
  }
  
  // Используем фиксированный rangeInterval (например, 10 бинов с каждой стороны)
  // Границы позиции будут рассчитаны автоматически на основе rangeInterval, binStep и текущей цены
  const rangeInterval = 10; // Можно настроить в зависимости от стратегии
  
  // Открываем позицию
  const positionManager = monitor['positionManager']; // В реальности нужен публичный метод
  const position = await positionManager.openPosition(
    pool.address,
    tokenXAmount,
    tokenYAmount,
    rangeInterval,
    config,
  );
  
  // Добавляем в мониторинг
  monitor.addPosition(position);
  
  return position;
}

