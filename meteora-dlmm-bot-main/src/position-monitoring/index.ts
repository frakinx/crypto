/**
 * Главный экспорт модуля мониторинга позиций
 */

export { PositionMonitor } from './monitor.js';
export { PositionManager } from './positionManager.js';
export { PriceMonitor } from './priceMonitor.js';
export { StrategyCalculator } from './strategyCalculator.js';
export { PoolSelector } from './poolSelector.js';
export { PositionStorage } from './storage.js';
export { loadAdminConfig, saveAdminConfig, DEFAULT_ADMIN_CONFIG, type AdminConfig } from './config.js';
export type { PositionInfo, PositionDecision, PositionStatus, PriceUpdate, FeeVsLossCalculation } from './types.js';

