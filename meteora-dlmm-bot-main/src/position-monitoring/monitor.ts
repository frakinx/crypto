import { Connection, Keypair } from '@solana/web3.js';
import { PriceMonitor } from './priceMonitor.js';
import { StrategyCalculator } from './strategyCalculator.js';
import { PositionManager } from './positionManager.js';
import { PoolSelector } from './poolSelector.js';
import { loadAdminConfig, type AdminConfig } from './config.js';
import type { PositionInfo, PositionDecision } from './types.js';

/**
 * Главный модуль мониторинга позиций
 * Объединяет все компоненты и управляет циклом мониторинга
 */

export class PositionMonitor {
  private connection: Connection;
  private userKeypair: Keypair;
  private priceMonitor: PriceMonitor;
  private strategyCalculator: StrategyCalculator;
  private positionManager: PositionManager;
  private poolSelector: PoolSelector;
  private config: AdminConfig;
  private monitoringInterval?: NodeJS.Timeout;
  private isRunning: boolean = false;

  constructor(connection: Connection, userKeypair: Keypair) {
    this.connection = connection;
    this.userKeypair = userKeypair;
    this.config = loadAdminConfig();
    
    // Инициализируем компоненты
    this.priceMonitor = new PriceMonitor(connection);
    this.strategyCalculator = new StrategyCalculator(this.priceMonitor);
    this.positionManager = new PositionManager(
      connection,
      userKeypair,
      this.priceMonitor,
      this.strategyCalculator,
    );
    this.poolSelector = new PoolSelector(connection, this.priceMonitor);
  }

  /**
   * Запустить мониторинг позиций
   */
  start(): void {
    if (this.isRunning) {
      console.warn('Position monitoring is already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting position monitoring...');

    // Запускаем цикл мониторинга
    this.monitoringInterval = setInterval(
      () => this.monitorPositions(),
      this.config.monitoring.checkIntervalMs,
    );

    // Первая проверка сразу
    this.monitorPositions();
  }

  /**
   * Остановить мониторинг
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    console.log('Position monitoring stopped');
  }

  /**
   * Основной цикл мониторинга позиций
   */
  private async monitorPositions(): Promise<void> {
    try {
      const activePositions = this.positionManager.getActivePositions();
      
      if (activePositions.length === 0) {
        console.log('No active positions to monitor');
        return;
      }

      console.log(`Monitoring ${activePositions.length} active positions...`);

      // Проверяем каждую позицию
      for (const position of activePositions) {
        try {
          const decision = await this.positionManager.makeDecision(position, this.config);
          await this.executeDecision(decision, position);
        } catch (error) {
          console.error(`Error monitoring position ${position.positionAddress}:`, error);
        }
      }
    } catch (error) {
      console.error('Error in monitoring cycle:', error);
    }
  }

  /**
   * Выполнить решение по позиции
   */
  private async executeDecision(decision: PositionDecision, position: PositionInfo): Promise<void> {
    switch (decision.action) {
      case 'close':
        console.log(`Closing position ${decision.positionAddress}: ${decision.reason}`);
        await this.positionManager.closePosition(decision.positionAddress, decision.reason);
        break;

      case 'open_new':
        console.log(`Opening new position: ${decision.reason}`);
        if (decision.newPositionParams) {
          await this.openNewPositionBelow(position, decision.newPositionParams);
        }
        break;

      case 'hedge':
        console.log(`Hedging position ${decision.positionAddress}: ${decision.reason}`);
        await this.executeHedge(position);
        break;

      case 'keep':
      case 'none':
        // Никаких действий не требуется
        break;

      default:
        console.warn(`Unknown action: ${decision.action}`);
    }
  }

  /**
   * Открыть новую позицию ниже текущей
   */
  private async openNewPositionBelow(
    oldPosition: PositionInfo,
    newPositionParams: { poolAddress: string; lowerBoundPrice: number; upperBoundPrice: number },
  ): Promise<void> {
    try {
      // Находим подходящий пул
      const pool = await this.poolSelector.findPoolForNewPosition(
        oldPosition.tokenXMint,
        oldPosition.tokenYMint,
        newPositionParams.lowerBoundPrice,
        this.config,
      );

      if (!pool) {
        console.error('Could not find suitable pool for new position');
        return;
      }

      // Рассчитываем количество токенов для новой позиции
      // Используем те же пропорции, что и в старой позиции
      const tokenXAmount = oldPosition.initialTokenXAmount;
      const tokenYAmount = oldPosition.initialTokenYAmount;

      // Рассчитываем rangeInterval на основе коридора
      const priceRange = newPositionParams.upperBoundPrice - newPositionParams.lowerBoundPrice;
      const currentPrice = (newPositionParams.upperBoundPrice + newPositionParams.lowerBoundPrice) / 2;
      const rangeInterval = Math.ceil((priceRange / currentPrice) * 100); // Примерная формула

      // Открываем новую позицию
      await this.positionManager.openPosition(
        pool.address,
        tokenXAmount,
        tokenYAmount,
        rangeInterval,
        this.config,
      );

      console.log(`New position opened below old position ${oldPosition.positionAddress}`);
    } catch (error) {
      console.error('Error opening new position below:', error);
    }
  }

  /**
   * Выполнить хеджирование через Mirror Swapping
   */
  private async executeHedge(position: PositionInfo): Promise<void> {
    if (!this.config.mirrorSwap.enabled) {
      return;
    }

    try {
      const currentPrice = position.currentPrice || position.initialPrice;
      const hedgeAmount = this.strategyCalculator.calculateHedgeAmount(
        position,
        currentPrice,
        position.initialPrice,
        this.config.mirrorSwap.hedgeAmountPercent,
      );

      // TODO: Выполнить swap через Jupiter для хеджирования
      // Это требует дополнительной реализации
      console.log(`Hedging position ${position.positionAddress} with amount: ${hedgeAmount}`);
    } catch (error) {
      console.error('Error executing hedge:', error);
    }
  }

  /**
   * Обновить конфигурацию
   */
  updateConfig(config: AdminConfig): void {
    this.config = config;
    console.log('Admin config updated');
  }

  /**
   * Получить все активные позиции
   */
  getActivePositions(): PositionInfo[] {
    return this.positionManager.getActivePositions();
  }

  /**
   * Добавить позицию в мониторинг
   */
  addPosition(position: PositionInfo): void {
    this.positionManager.addPosition(position);
  }

  /**
   * Получить конфигурацию (для внешнего доступа)
   */
  getConfig(): AdminConfig {
    return this.config;
  }

  /**
   * Получить pool selector (для внешнего доступа)
   */
  getPoolSelector(): PoolSelector {
    return this.poolSelector;
  }

  /**
   * Получить position manager (для внешнего доступа)
   */
  getPositionManager(): PositionManager {
    return this.positionManager;
  }

  /**
   * Получить price monitor (для внешнего доступа)
   */
  getPriceMonitor(): PriceMonitor {
    return this.priceMonitor;
  }
}

