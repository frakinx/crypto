import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PriceMonitor } from './priceMonitor.js';
import { StrategyCalculator } from './strategyCalculator.js';
import { PositionManager } from './positionManager.js';
import { PoolSelector } from './poolSelector.js';
import { HedgeManager } from './hedgeManager.js';
import { loadAdminConfig, getPoolConfigOrDefault, type AdminConfig } from './config.js';
import type { PositionInfo, PositionDecision } from './types.js';
import type { DlmmPair } from '../dex/meteora.js';

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
  private hedgeManager: HedgeManager;
  private config: AdminConfig;
  private monitoringInterval?: NodeJS.Timeout;
  private isRunning: boolean = false;
  // Хранилище последних ошибок открытия позиций (чтобы не повторять попытки)
  private lastOpenPositionErrors: Map<string, { timestamp: number; error: string }> = new Map();

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
    this.hedgeManager = new HedgeManager(
      connection,
      userKeypair,
      this.strategyCalculator,
    );
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
    
    // Запускаем hedging для всех существующих активных позиций
    this.startHedgingForExistingPositions();
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
      // Синхронизируем позиции из хранилища перед проверкой
      // Это позволяет подхватывать позиции, открытые через веб-интерфейс
      // Также проверяет, не закрыты ли позиции на Meteora
      const previousPositions = new Set(this.positionManager.getActivePositions().map(p => p.positionAddress));
      await this.positionManager.syncPositionsFromStorage();
      
      const activePositions = this.positionManager.getActivePositions();
      
      // Запускаем hedge для новых позиций, которых не было раньше
      if (this.config.mirrorSwap.enabled) {
        for (const position of activePositions) {
          if (!previousPositions.has(position.positionAddress) && position.status === 'active') {
            console.log(`Starting hedge for newly synced position: ${position.positionAddress}`);
            await this.startHedgingForPosition(position);
          }
        }
      }
      
      if (activePositions.length === 0) {
        console.log('No active positions to monitor');
        return;
      }

      console.log(`[BOT] Monitoring ${activePositions.length} active position(s)...`);
      
      // Логируем все активные позиции для отладки (только если их больше 1)
      if (activePositions.length > 1) {
        console.log(`[BOT] 📊 Active positions list:`, activePositions.map(p => ({
          address: p.positionAddress.substring(0, 8) + '...',
          lowerBound: p.lowerBoundPrice.toFixed(2),
          upperBound: p.upperBoundPrice.toFixed(2),
          status: p.status,
        })));
      }

      // Проверяем каждую позицию
      for (const position of activePositions) {
        try {
          // Проверяем авто-клейм комиссий
          if (position.autoClaim?.enabled && position.status === 'active') {
            await this.checkAndClaimFees(position);
          }

          // Получаем конфигурацию пула для этой позиции (или используем глобальную по умолчанию)
          const poolConfig = getPoolConfigOrDefault(position.poolAddress);
          // Объединяем конфигурацию пула с глобальной конфигурацией для создания полного AdminConfig
          const configForPosition: AdminConfig = {
            ...this.config,
            stopLossPercent: poolConfig.stopLossPercent,
            feeCheckPercent: poolConfig.feeCheckPercent,
            takeProfitPercent: poolConfig.takeProfitPercent,
            mirrorSwap: poolConfig.mirrorSwap,
          };
          const decision = await this.positionManager.makeDecision(position, configForPosition);
          
          // Логируем решение только если это не 'none' (чтобы не засорять логи)
          if (decision.action !== 'none') {
            console.log(`[Decision] Position ${position.positionAddress.substring(0, 8)}...: ${decision.action} - ${decision.reason}`);
          }
          
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
        // Останавливаем hedging перед закрытием позиции
        this.hedgeManager.stopHedging(decision.positionAddress);
        await this.positionManager.closePosition(decision.positionAddress, decision.reason);
        break;

      case 'open_new':
        console.log(`Opening new position: ${decision.reason}`);
        console.log(`[Decision] has newPositionParams: ${!!decision.newPositionParams}`);
        
        // Проверяем, не было ли недавно ошибки открытия позиции для этой позиции
        const lastError = this.lastOpenPositionErrors.get(position.positionAddress);
        if (lastError && Date.now() - lastError.timestamp < 60000) { // 60 секунд
          if (lastError.error.includes('Insufficient balance')) {
            console.warn(`[BOT] ⏭️ Skipping open_new - insufficient balance error occurred ${Math.round((Date.now() - lastError.timestamp) / 1000)}s ago. Will retry later.`);
            return; // Не пытаемся открыть позицию, если недавно была ошибка недостаточного баланса
          }
        }
        
        if (decision.newPositionParams) {
          // Всегда закрываем старую позицию перед открытием новой
          console.log(`[BOT] 🔴 Closing old position ${decision.positionAddress.substring(0, 8)}... before opening new one`);
          // Останавливаем hedging перед закрытием позиции
          this.hedgeManager.stopHedging(decision.positionAddress);
          try {
            const closeSignature = await this.positionManager.closePosition(
              decision.positionAddress,
              decision.reason.split(' - ')[0] || 'Closing before opening new position',
            );
            
            if (!closeSignature) {
              console.error(`[BOT] ❌ Failed to close position ${decision.positionAddress.substring(0, 8)}... - no signature returned`);
              return; // Не открываем новую позицию, если старая не закрыта
            }
            
            // Ждем подтверждения транзакции закрытия, чтобы токены вернулись в кошелек
            console.log(`[BOT] ⏳ Waiting for close transaction confirmation: ${closeSignature}`);
            try {
              await this.connection.confirmTransaction(closeSignature, 'confirmed');
              console.log(`[BOT] ✅ Close transaction confirmed, waiting for balance to update...`);
              
              // Ждем и проверяем баланс SOL несколько раз, чтобы убедиться что rent вернулся
              for (let i = 0; i < 5; i++) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                const solBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
                console.log(`[BOT] Balance check ${i + 1}/5: ${(solBalance / 1e9).toFixed(6)} SOL`);
              }
            } catch (error) {
              console.warn(`[BOT] ⚠️ Failed to confirm close transaction, proceeding anyway:`, error);
            }
          } catch (closeError) {
            console.error(`[BOT] ❌ Error closing position ${decision.positionAddress.substring(0, 8)}...:`, closeError);
            return; // Не открываем новую позицию, если старая не закрыта
          }
          
          try {
            await this.openNewPosition(position, decision.newPositionParams);
            // Если успешно открыли позицию, очищаем ошибку
            this.lastOpenPositionErrors.delete(position.positionAddress);
          } catch (error) {
            // Сохраняем ошибку для предотвращения повторных попыток
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.lastOpenPositionErrors.set(position.positionAddress, {
              timestamp: Date.now(),
              error: errorMsg,
            });
            console.error(`[BOT] Error opening new position: ${errorMsg}`);
            // Не пробрасываем ошибку дальше, чтобы не прерывать мониторинг других позиций
          }
        } else {
          console.error(`[BOT] ❌ Cannot open new position - newPositionParams is missing`);
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
   * Проверить и выполнить авто-клейм комиссий
   */
  private async checkAndClaimFees(position: PositionInfo): Promise<void> {
    if (!position.autoClaim?.enabled || !position.autoClaim?.thresholdUSD) {
      return;
    }

    try {
      // Получаем реальные claimable fees через strategyCalculator
      const accumulatedFees = await this.strategyCalculator.getRealAccumulatedFees(
        this.connection,
        position,
        position.currentPrice || position.initialPrice,
      );

      // Проверяем, достиг ли порог
      if (accumulatedFees >= position.autoClaim.thresholdUSD) {
        console.log(`[BOT] 💰 Auto-claim triggered for position ${position.positionAddress.substring(0, 8)}...:`, {
          accumulatedFees: `$${accumulatedFees.toFixed(2)}`,
          threshold: `$${position.autoClaim.thresholdUSD.toFixed(2)}`,
        });

        // Выполняем клейм
        await this.positionManager.claimFees(position.positionAddress);
      }
    } catch (error) {
      console.warn(`[BOT] ⚠️ Failed to check/claim fees for position ${position.positionAddress.substring(0, 8)}...:`, error);
    }
  }

  /**
   * Автоматически купить недостающие токены через Jupiter swap
   */
  private async buyMissingTokens(
    tokenXMint: string,
    tokenYMint: string,
    requiredX: bigint,
    requiredY: bigint,
    availableX: string,
    availableY: string,
    poolAddress: string,
  ): Promise<{ success: boolean; error?: string; transactionBase64?: string; type?: string; missingAmount?: string }> {
    try {
      const { getQuote, createSwapTransaction } = await import('../dex/jupiter.js');
      const { signAndSend } = await import('../execution/trader.js');
      const { toSmallestUnitsAuto, fromSmallestUnitsAuto } = await import('../utils/tokenUtils.js');
      const { getAssociatedTokenAddress } = await import('@solana/spl-token');
      
      const missingX = requiredX - BigInt(availableX);
      const missingY = requiredY - BigInt(availableY);
      
      // Определяем, какие токены нужно купить
      const SOL_MINT = 'So11111111111111111111111111111111111111112';
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
      
      // Если не хватает Token X
      if (missingX > 0n) {
        console.log(`[BOT] 🔄 Need to buy ${missingX.toString()} units of Token X`);
        
        // Определяем, какой токен использовать для покупки (обычно Token Y или SOL)
        let inputMint: string;
        let inputAmount: bigint;
        
        if (tokenYMint === USDC_MINT || tokenYMint === USDT_MINT) {
          // Если Token Y - стейблкоин, используем его для покупки Token X
          inputMint = tokenYMint;
          // Конвертируем missingX в USD эквивалент (упрощенно, используем текущую цену)
          const currentPrice = await this.priceMonitor.getPoolPrice(poolAddress);
          const missingXHuman = await fromSmallestUnitsAuto(this.connection, missingX.toString(), tokenXMint);
          const missingXUSD = missingXHuman * currentPrice;
          inputAmount = await toSmallestUnitsAuto(this.connection, missingXUSD, tokenYMint);
        } else if (tokenXMint === SOL_MINT) {
          // Если Token X - SOL, а Token Y не стейблкоин, используем SOL из баланса
          const solBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
          if (BigInt(solBalance) < missingX) {
            return { success: false, error: 'Not enough SOL to buy missing Token X' };
          }
          // Для SOL swap не нужен, так как это нативный токен
          return { success: true }; // SOL уже доступен
        } else {
          // Пробуем использовать Token Y для покупки Token X
          inputMint = tokenYMint;
          const availableYBigInt = BigInt(availableY);
          if (availableYBigInt < missingX) {
            return { success: false, error: 'Not enough Token Y to buy missing Token X' };
          }
          inputAmount = missingX; // Упрощенно
        }
        
        // Выполняем swap
        const quote = await getQuote({
          inputMint,
          outputMint: tokenXMint,
          amount: Number(inputAmount),
          slippageBps: 100, // 1% slippage
        });
        
        if (!quote || !quote.outAmount) {
          return { success: false, error: 'No quote available for Token X swap' };
        }
        
        const swapTx = await createSwapTransaction(
          this.connection,
          this.userKeypair.publicKey,
          quote,
        );
        
        // Отправляем транзакцию на подпись через API вместо автоматической подписи
        const serialized = Buffer.from(swapTx.serialize()).toString('base64');
        console.log(`[BOT] 📝 Token X swap transaction created, waiting for user signature...`);
        console.log(`[BOT] 🔗 Please sign the transaction via API: POST /api/tx/sign-for-token-purchase`);
        // Возвращаем информацию о транзакции для подписи
        return { 
          success: false, 
          error: 'Transaction requires user signature',
          transactionBase64: serialized,
          type: 'buy_token_x',
          missingAmount: missingX.toString(),
        };
      }
      
      // Если не хватает Token Y
      if (missingY > 0n) {
        console.log(`[BOT] 🔄 Need to buy ${missingY.toString()} units of Token Y`);
        
        // Определяем, какой токен использовать для покупки
        let inputMint: string;
        let inputAmount: bigint;
        
        if (tokenXMint === SOL_MINT) {
          // Если Token X - SOL, используем его для покупки Token Y
          const solBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
          const missingYHuman = await fromSmallestUnitsAuto(this.connection, missingY.toString(), tokenYMint);
          // Для стейблкоинов 1 токен = 1 USD, для SOL нужна цена
          const currentPrice = await this.priceMonitor.getPoolPrice(poolAddress);
          const missingYUSD = missingYHuman; // Token Y обычно стейблкоин
          const missingYSOL = missingYUSD / currentPrice;
          const missingYSOLBigInt = await toSmallestUnitsAuto(this.connection, missingYSOL, SOL_MINT);
          
          if (BigInt(solBalance) < missingYSOLBigInt) {
            return { success: false, error: 'Not enough SOL to buy missing Token Y' };
          }
          inputMint = SOL_MINT;
          inputAmount = missingYSOLBigInt;
        } else {
          // Используем Token X для покупки Token Y
          inputMint = tokenXMint;
          const availableXBigInt = BigInt(availableX);
          const missingYHuman = await fromSmallestUnitsAuto(this.connection, missingY.toString(), tokenYMint);
          const currentPrice = await this.priceMonitor.getPoolPrice(poolAddress);
          const missingXNeeded = missingYHuman / currentPrice;
          inputAmount = await toSmallestUnitsAuto(this.connection, missingXNeeded, tokenXMint);
          
          if (availableXBigInt < inputAmount) {
            return { success: false, error: 'Not enough Token X to buy missing Token Y' };
          }
        }
        
        // Выполняем swap
        const quote = await getQuote({
          inputMint,
          outputMint: tokenYMint,
          amount: Number(inputAmount),
          slippageBps: 100, // 1% slippage
        });
        
        if (!quote || !quote.outAmount) {
          return { success: false, error: 'No quote available for Token Y swap' };
        }
        
        const swapTx = await createSwapTransaction(
          this.connection,
          this.userKeypair.publicKey,
          quote,
        );
        
        // Отправляем транзакцию на подпись через API вместо автоматической подписи
        const serialized = Buffer.from(swapTx.serialize()).toString('base64');
        console.log(`[BOT] 📝 Token Y swap transaction created, waiting for user signature...`);
        console.log(`[BOT] 🔗 Please sign the transaction via API: POST /api/tx/sign-for-token-purchase`);
        // Возвращаем информацию о транзакции для подписи
        return { 
          success: false, 
          error: 'Transaction requires user signature',
          transactionBase64: serialized,
          type: 'buy_token_y',
          missingAmount: missingY.toString(),
        };
      }
      
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[BOT] ❌ Error buying missing tokens:`, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Открыть новую позицию (выше или ниже текущей цены)
   */
  private async openNewPosition(
    oldPosition: PositionInfo,
    newPositionParams: { poolAddress: string; rangeInterval: number; direction?: 'above' | 'below' },
  ): Promise<void> {
    const direction = newPositionParams.direction || 'below'; // По умолчанию ниже
    try {
      // Сначала пробуем использовать тот же пул, где была открыта старая позиция
      // Это более надежно, так как пул точно существует и подходит для этих токенов
      let pool: DlmmPair | null = null;
      
      try {
        const { fetchDlmmPairs } = await import('../dex/meteora.js');
        const allPools = await fetchDlmmPairs();
        pool = allPools.find(p => p.address === oldPosition.poolAddress) || null;
        
        if (pool) {
          console.log(`Using same pool ${pool.address.substring(0, 8)}... for new position`);
        }
      } catch (error) {
        // Обрабатываем сетевые ошибки (SocketError, таймауты и т.д.)
        if (error instanceof Error && (error.message.includes('SocketError') || error.message.includes('other side closed') || error.message.includes('ECONNRESET'))) {
          console.warn(`[BOT] ⚠️ Network error while finding pool (will retry): ${error.message.substring(0, 100)}`);
        } else {
          console.warn('Failed to find same pool, trying to find new one:', error);
        }
      }
      
      // Если не нашли тот же пул, ищем подходящий
      if (!pool) {
        // Получаем текущую цену для поиска пула
        const currentPrice = await this.priceMonitor.getPoolPrice(oldPosition.poolAddress);
        pool = await this.poolSelector.findPoolForNewPosition(
          oldPosition.tokenXMint,
          oldPosition.tokenYMint,
          currentPrice,
          this.config,
        );
      }

      if (!pool) {
        console.error(`Could not find suitable pool for new position. Token pair: ${oldPosition.tokenXMint}/${oldPosition.tokenYMint}`);
        console.error(`Tried to use pool ${oldPosition.poolAddress} but it was not found in available pools.`);
        return;
      }

      // Получаем реальные балансы токенов и ждем поступления средств, если их недостаточно
      const requestedX = BigInt(oldPosition.initialTokenXAmount);
      const requestedY = BigInt(oldPosition.initialTokenYAmount);
      
      const tokenXATA = await getAssociatedTokenAddress(
        new PublicKey(oldPosition.tokenXMint),
        this.userKeypair.publicKey,
      );
      const tokenYATA = await getAssociatedTokenAddress(
        new PublicKey(oldPosition.tokenYMint),
        this.userKeypair.publicKey,
      );
      
      // Функция для проверки балансов
      // Используем несколько методов для надежности
      const checkBalances = async (): Promise<{ tokenXAmount: string; tokenYAmount: string; hasEnough: boolean }> => {
        let availableX = BigInt(0);
        let availableY = BigInt(0);
        
        // Проверяем, является ли Token X нативным SOL
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const SYSTEM_PROGRAM = '11111111111111111111111111111111';
        const isTokenXSOL = oldPosition.tokenXMint === SOL_MINT || oldPosition.tokenXMint === SYSTEM_PROGRAM;
        
        // Метод 0: Если Token X - это нативный SOL, проверяем баланс кошелька напрямую
        if (isTokenXSOL) {
          try {
            const solBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
            availableX = BigInt(solBalance);
            console.log(`[BOT] Token X is native SOL, wallet balance: ${availableX.toString()} lamports (${(Number(availableX) / 1e9).toFixed(6)} SOL)`);
          } catch (error) {
            console.warn(`[BOT] Error getting SOL balance:`, error);
          }
        }
        
        // Метод 1: getParsedTokenAccountsByOwner - получаем все токен-аккаунты через Connection API
        // Пропускаем для нативного SOL, так как он не в токен-аккаунте
        if (!isTokenXSOL) {
          try {
            const allTokenAccountsResponse = await this.connection.getParsedTokenAccountsByOwner(
              this.userKeypair.publicKey,
              { programId: TOKEN_PROGRAM_ID }
            );
            
            const allTokenAccounts = allTokenAccountsResponse.value;
            console.log(`[BOT] Found ${allTokenAccounts.length} token accounts for user`);
            
            for (const account of allTokenAccounts) {
              try {
                // Проверяем структуру данных
                const parsedData = account.account?.data?.parsed;
                if (!parsedData || parsedData.type !== 'account') continue;
                
                const info = parsedData.info;
                const mint = info?.mint;
                const tokenAmount = info?.tokenAmount;
                
                if (!mint || !tokenAmount) continue;
                
                const amount = BigInt(tokenAmount.amount || '0');
                
                if (mint === oldPosition.tokenXMint) {
                  availableX += amount;
                  console.log(`[BOT] Found Token X account: ${account.pubkey.toBase58()}, amount: ${amount.toString()}`);
                }
                if (mint === oldPosition.tokenYMint) {
                  availableY += amount;
                  console.log(`[BOT] Found Token Y account: ${account.pubkey.toBase58()}, amount: ${amount.toString()}`);
                }
              } catch (accountError) {
                console.warn(`[BOT] Error parsing token account:`, accountError);
              }
            }
          } catch (error) {
            console.warn(`[BOT] Error using getParsedTokenAccountsByOwner:`, error);
          }
        }
        
        // Метод 2: Проверяем ATA (Associated Token Accounts) напрямую
        // Для нативного SOL ATA не существует, пропускаем
        if (!isTokenXSOL) {
          try {
            const tokenXBalance = await this.connection.getTokenAccountBalance(tokenXATA, 'confirmed');
            const ataX = BigInt(tokenXBalance.value.amount);
            
            // Добавляем к уже найденным балансам (на случай, если есть несколько аккаунтов)
            if (ataX > 0) {
              console.log(`[BOT] Token X ATA balance: ${ataX.toString()}`);
              availableX += ataX;
            }
          } catch (ataError: any) {
            // Если ATA не существует, это нормально - токены могут быть в других аккаунтах
            if (!ataError.message?.includes('Invalid param: could not find account')) {
              console.warn(`[BOT] Error checking Token X ATA balance:`, ataError.message);
            }
          }
        }
        
        // Проверяем Token Y ATA (всегда проверяем, так как это не нативный токен)
        try {
          const tokenYBalance = await this.connection.getTokenAccountBalance(tokenYATA, 'confirmed');
          const ataY = BigInt(tokenYBalance.value.amount);
          
          if (ataY > 0) {
            console.log(`[BOT] Token Y ATA balance: ${ataY.toString()}`);
            availableY += ataY;
          }
        } catch (ataError: any) {
          // Если ATA не существует, это нормально - токены могут быть в других аккаунтах
          if (!ataError.message?.includes('Invalid param: could not find account')) {
            console.warn(`[BOT] Error checking Token Y ATA balance:`, ataError.message);
          }
        }
        
        const hasEnough = availableX >= requestedX && availableY >= requestedY;
        
        // Используем минимум из доступного и запрошенного
        const tokenXAmount = (availableX < requestedX ? availableX : requestedX).toString();
        const tokenYAmount = (availableY < requestedY ? availableY : requestedY).toString();
        
        console.log(`[BOT] Balance check result:`, {
          tokenXMint: oldPosition.tokenXMint.substring(0, 8) + '...',
          tokenYMint: oldPosition.tokenYMint.substring(0, 8) + '...',
          requestedX: requestedX.toString(),
          requestedY: requestedY.toString(),
          availableX: availableX.toString(),
          availableY: availableY.toString(),
          hasEnough,
        });
        
        return { tokenXAmount, tokenYAmount, hasEnough };
      };
      
      // Проверяем балансы сразу
      let balances = await checkBalances();
      
      // Ждем поступления токенов из закрытой позиции
      let attempts = 0;
      const maxAttempts = 30; // Максимум 30 попыток (около 1 минуты при задержке 2 секунды)
      const checkInterval = 2000; // Проверяем каждые 2 секунды
      
      // Если средств недостаточно, ждем их поступления
      while (!balances.hasEnough && attempts < maxAttempts) {
        attempts++;
        console.log(`[BOT] Waiting for tokens from closed position (attempt ${attempts}/${maxAttempts}):`, {
          requestedX: requestedX.toString(),
          requestedY: requestedY.toString(),
          availableX: balances.tokenXAmount,
          availableY: balances.tokenYAmount,
          tokenXMint: oldPosition.tokenXMint.substring(0, 8) + '...',
          tokenYMint: oldPosition.tokenYMint.substring(0, 8) + '...',
          tokenXATA: tokenXATA.toBase58().substring(0, 8) + '...',
          tokenYATA: tokenYATA.toBase58().substring(0, 8) + '...',
        });
        
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        balances = await checkBalances();
      }
      
      // Если после ожидания все еще недостаточно токенов, пытаемся купить недостающие через swap
      if (!balances.hasEnough) {
        console.log(`[BOT] 🔄 Attempting to buy missing tokens via swap...`);
        const swapResult = await this.buyMissingTokens(
          oldPosition.tokenXMint,
          oldPosition.tokenYMint,
          requestedX,
          requestedY,
          balances.tokenXAmount,
          balances.tokenYAmount,
          oldPosition.poolAddress,
        );
        
        if (swapResult.success) {
          console.log(`[BOT] ✅ Successfully bought missing tokens via swap`);
          // Обновляем балансы после swap
          await new Promise(resolve => setTimeout(resolve, 3000)); // Ждем обновления балансов
          balances = await checkBalances();
        } else if (swapResult.transactionBase64) {
          // Транзакция создана, но требует подписи пользователя
          console.log(`[BOT] 📝 Token purchase transaction created, requires user signature`);
          console.log(`[BOT] 📋 Transaction details:`, {
            type: swapResult.type,
            missingAmount: swapResult.missingAmount,
            transactionBase64: swapResult.transactionBase64.substring(0, 50) + '...',
          });
          console.log(`[BOT] ⚠️ Please sign the transaction via web interface or API`);
          console.log(`[BOT] ⏸️ Waiting for user to sign transaction...`);
          // Не открываем позицию, пока транзакция не будет подписана
          return;
        } else {
          console.error(`[BOT] ❌ Failed to buy missing tokens: ${swapResult.error}`);
          console.error(`[BOT] Required: X=${requestedX.toString()}, Y=${requestedY.toString()}`);
          console.error(`[BOT] Available: X=${balances.tokenXAmount}, Y=${balances.tokenYAmount}`);
          return; // Не открываем позицию, если не удалось купить недостающие токены
        }
      }
      
      // Финальная проверка балансов после попытки покупки
      if (!balances.hasEnough) {
        console.error(`[BOT] ❌ Not enough tokens after swap attempt. Cannot open new position.`);
        console.error(`[BOT] Required: X=${requestedX.toString()}, Y=${requestedY.toString()}`);
        console.error(`[BOT] Available: X=${balances.tokenXAmount}, Y=${balances.tokenYAmount}`);
        return;
      }
      
      console.log(`[BOT] ✅ Sufficient token balances found:`, {
        tokenX: balances.tokenXAmount,
        tokenY: balances.tokenYAmount,
      });
      
      const tokenXAmount = balances.tokenXAmount;
      const tokenYAmount = balances.tokenYAmount;

      // Используем rangeInterval из параметров (из старой позиции)
      // Если rangeInterval undefined, вычисляем его из minBinId и maxBinId старой позиции
      let rangeInterval = newPositionParams.rangeInterval;
      
      if (!rangeInterval || rangeInterval <= 0) {
        // Вычисляем rangeInterval из старых bin IDs
        if (oldPosition.minBinId !== undefined && oldPosition.maxBinId !== undefined) {
          const numBins = oldPosition.maxBinId - oldPosition.minBinId + 1;
          rangeInterval = Math.floor(numBins / 2);
          console.log(`[BOT] Calculated rangeInterval from bins: ${rangeInterval} (numBins: ${numBins})`);
        } else {
          // Fallback: используем значение по умолчанию
          rangeInterval = 10;
          console.warn(`[BOT] ⚠️ rangeInterval not found, using default: ${rangeInterval}`);
        }
      }
      
      // Валидация rangeInterval
      if (rangeInterval < 1 || rangeInterval > 100) {
        console.error(`[BOT] ❌ Invalid rangeInterval: ${rangeInterval}, using default: 10`);
        rangeInterval = 10;
      }
      
      console.log(`[BOT] Using rangeInterval: ${rangeInterval} for new position`);

      // Проверяем баланс SOL перед открытием позиции
      // Для создания позиции нужны дополнительные SOL для rent аккаунта и комиссий
      try {
        const solBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
        // Минимальная сумма для rent позиции (примерно 0.001-0.002 SOL) + комиссии (0.000005 SOL) + запас
        // Используем 0.06 SOL как безопасный минимум (из логов видно, что нужно ~0.057 SOL)
        const MIN_SOL_FOR_POSITION = 0.06 * 1e9; // 0.06 SOL в lamports
        const solBalanceSOL = solBalance / 1e9;
        
        // Если Token X - это нативный SOL, нужно учесть, что часть SOL уже используется для позиции
        const SOL_MINT = 'So11111111111111111111111111111111111111112';
        const SYSTEM_PROGRAM = '11111111111111111111111111111111';
        const isTokenXSOL = oldPosition.tokenXMint === SOL_MINT || oldPosition.tokenXMint === SYSTEM_PROGRAM;
        
        // Если Token X - SOL, то tokenXAmount уже вычитается из баланса
        // Нужно проверить, что после вычета tokenXAmount остается достаточно SOL для rent и комиссий
        let availableSOLForRent = solBalance;
        if (isTokenXSOL) {
          const tokenXAmountBN = BigInt(tokenXAmount);
          availableSOLForRent = solBalance - Number(tokenXAmountBN);
        }
        
        console.log(`[BOT] SOL balance check:`, {
          totalBalance: `${solBalanceSOL.toFixed(6)} SOL (${solBalance} lamports)`,
          isTokenXSOL,
          tokenXAmount: isTokenXSOL ? `${(Number(tokenXAmount) / 1e9).toFixed(6)} SOL` : 'N/A',
          availableForRent: `${(availableSOLForRent / 1e9).toFixed(6)} SOL (${availableSOLForRent} lamports)`,
          required: `${(MIN_SOL_FOR_POSITION / 1e9).toFixed(6)} SOL`,
          hasEnough: availableSOLForRent >= MIN_SOL_FOR_POSITION,
        });
        
        // Проверяем SOL баланс с повторными попытками (баланс может обновляться постепенно)
        let solBalanceCheckAttempts = 1; // Уже проверили 1 раз
        const MAX_SOL_CHECK_ATTEMPTS = 3;
        let finalAvailableSOL = availableSOLForRent;
        
        // Если баланс недостаточен, пытаемся проверить еще раз после ожидания
        while (finalAvailableSOL < MIN_SOL_FOR_POSITION && solBalanceCheckAttempts < MAX_SOL_CHECK_ATTEMPTS) {
          console.log(`[BOT] ⏳ Waiting for SOL balance to update (attempt ${solBalanceCheckAttempts + 1}/${MAX_SOL_CHECK_ATTEMPTS})...`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          
          // Повторно проверяем баланс
          const updatedSolBalance = await this.connection.getBalance(this.userKeypair.publicKey, 'confirmed');
          if (isTokenXSOL) {
            const tokenXAmountBN = BigInt(tokenXAmount);
            finalAvailableSOL = updatedSolBalance - Number(tokenXAmountBN);
          } else {
            finalAvailableSOL = updatedSolBalance;
          }
          
          console.log(`[BOT] Balance check attempt ${solBalanceCheckAttempts + 1}: ${(finalAvailableSOL / 1e9).toFixed(6)} SOL available`);
          
          solBalanceCheckAttempts++;
          
          if (finalAvailableSOL >= MIN_SOL_FOR_POSITION) {
            console.log(`[BOT] ✅ Sufficient SOL balance after ${solBalanceCheckAttempts} check(s)`);
            break; // Достаточно SOL, продолжаем
          }
        }
        
        if (finalAvailableSOL < MIN_SOL_FOR_POSITION) {
          console.error(`[BOT] ❌ Insufficient SOL balance for position creation after ${solBalanceCheckAttempts} attempts!`);
          console.error(`[BOT] Required: ${(MIN_SOL_FOR_POSITION / 1e9).toFixed(6)} SOL (for rent + fees)`);
          console.error(`[BOT] Available: ${(finalAvailableSOL / 1e9).toFixed(6)} SOL`);
          console.error(`[BOT] Missing: ${((MIN_SOL_FOR_POSITION - finalAvailableSOL) / 1e9).toFixed(6)} SOL`);
          console.error(`[BOT] Please add more SOL to your wallet to cover rent and transaction fees.`);
          return; // Не открываем позицию без достаточного SOL
        }
      } catch (solError) {
        console.error(`[BOT] ❌ Error checking SOL balance:`, solError);
        return; // Не открываем позицию, если не можем проверить баланс
      }

      // Открываем новую позицию
      const newPosition = await this.positionManager.openPosition(
        pool.address,
        tokenXAmount,
        tokenYAmount,
        rangeInterval,
        this.config,
      );

      if (newPosition) {
        const directionText = direction === 'above' ? 'above' : 'below';
        console.log(`[BOT] ✅ New position opened ${directionText} old position ${oldPosition.positionAddress.substring(0, 8)}...`);
        console.log(`[BOT] 📊 Active positions count: ${this.positionManager.getActivePositions().length}`);

        // Запускаем Mirror Swapping для новой позиции (дельта-нейтральность)
        if (this.config.mirrorSwap.enabled) {
          await this.startHedgingForPosition(newPosition);
        }
      } else {
        console.error(`[BOT] ❌ Failed to open new position ${direction === 'above' ? 'above' : 'below'} ${oldPosition.positionAddress.substring(0, 8)}...`);
      }
    } catch (error) {
      console.error(`Error opening new position ${direction === 'above' ? 'above' : 'below'}:`, error);
    }
  }

  /**
   * Запустить hedging для всех существующих активных позиций при старте
   */
  private async startHedgingForExistingPositions(): Promise<void> {
    if (!this.config.mirrorSwap.enabled) {
      return;
    }

    const activePositions = this.positionManager.getActivePositions();
    console.log(`Starting hedging for ${activePositions.length} existing active positions...`);

    for (const position of activePositions) {
      if (position.status === 'active') {
        await this.startHedgingForPosition(position);
      }
    }
  }

  /**
   * Запустить постоянный hedging для позиции (Mirror Swapping для дельта-нейтральности)
   */
  private async startHedgingForPosition(position: PositionInfo): Promise<void> {
    // Получаем конфигурацию пула для этой позиции
    const poolConfig = getPoolConfigOrDefault(position.poolAddress);
    const configForPosition: AdminConfig = {
      ...this.config,
      stopLossPercent: poolConfig.stopLossPercent,
      feeCheckPercent: poolConfig.feeCheckPercent,
      takeProfitPercent: poolConfig.takeProfitPercent,
      mirrorSwap: poolConfig.mirrorSwap,
    };

    if (!configForPosition.mirrorSwap.enabled) {
      return;
    }

    try {
      // Получаем актуальное распределение токенов в позиции
      let positionBinData: Array<{ binId: number; amountX: any; amountY: any }> | undefined;
      try {
        const { getPositionBinData } = await import('../dex/meteora.js');
        positionBinData = await getPositionBinData(
          this.connection,
          position.poolAddress,
          position.positionAddress,
          new PublicKey(position.userAddress),
        );
      } catch (error) {
        console.warn(`Failed to get position bin data for initial hedge: ${(error as Error).message}`);
        // Продолжаем без binData
      }

      // Запускаем постоянный hedging через HedgeManager
      this.hedgeManager.startHedging(position, configForPosition, positionBinData);
      console.log(`Started Mirror Swapping hedging for position ${position.positionAddress}`);
    } catch (error) {
      console.error(`Error starting hedge for position ${position.positionAddress}:`, error);
    }
  }

  /**
   * Выполнить хеджирование через Mirror Swapping
   * Получает актуальные данные о позиции и выполняет hedge swap
   */
  private async executeHedge(position: PositionInfo): Promise<void> {
    // Получаем конфигурацию пула для этой позиции
    const poolConfig = getPoolConfigOrDefault(position.poolAddress);
    const configForPosition: AdminConfig = {
      ...this.config,
      stopLossPercent: poolConfig.stopLossPercent,
      feeCheckPercent: poolConfig.feeCheckPercent,
      takeProfitPercent: poolConfig.takeProfitPercent,
      mirrorSwap: poolConfig.mirrorSwap,
    };

    if (!configForPosition.mirrorSwap.enabled) {
      return;
    }

    try {
      // Получаем актуальное распределение токенов в позиции для правильного расчета hedge
      let positionBinData: Array<{ binId: number; amountX: any; amountY: any }> | undefined;
      try {
        const { getPositionBinData } = await import('../dex/meteora.js');
        positionBinData = await getPositionBinData(
          this.connection,
          position.poolAddress,
          position.positionAddress,
          new PublicKey(position.userAddress),
        );
      } catch (error) {
        console.warn(`Failed to get position bin data for hedge: ${(error as Error).message}`);
        // Продолжаем без binData, будет использоваться упрощенный расчет
      }

      // Используем HedgeManager для выполнения hedge swap
      await this.hedgeManager.executeHedge(position, configForPosition, positionBinData);
    } catch (error) {
      console.error(`Error executing hedge for position ${position.positionAddress}:`, error);
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
   * Добавить позицию в мониторинг и запустить hedging
   */
  addPosition(position: PositionInfo): void {
    this.positionManager.addPosition(position);
    
    // Запускаем Mirror Swapping для новой позиции (дельта-нейтральность)
    if (this.config.mirrorSwap.enabled && position.status === 'active') {
      this.startHedgingForPosition(position).catch(err => {
        console.error(`Error starting hedge for added position ${position.positionAddress}:`, err);
      });
    }
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

