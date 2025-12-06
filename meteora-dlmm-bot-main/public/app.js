let allPools = [];
let filteredPools = [];
let displayedCount = 40;
const POOLS_PER_PAGE = 40;
const AUTO_REFRESH_INTERVAL = 180000; // 3 минуты в миллисекундах
let autoRefreshTimer = null;
let nextRefreshTime = null;
let refreshInfoTimer = null;

// Фильтры
let filters = {
  verified: false,
  channelWidth: null, // Ширина канала в одну сторону (%)
  binStepMin: null,
  binStepMax: null,
  liquidityMin: null,
  liquidityMax: null,
  volumePeriod: 'hour_24',
  volumePeriodMin: null,
  feesPeriod: 'hour_24',
  feesPeriodMin: null,
  fees24hMin: null,
  fees24hMax: null,
  feeTvlPeriod: 'hour_24',
  feeTvlPeriodMin: null,
  aprMin: null,
  aprMax: null,
  launchpads: [], // массив выбранных launchpad
  lfg: false
};

// Список доступных launchpad
const LAUNCHPADS = [
  'Pump.fun',
  'Letsbonk.fun',
  'Cooking.City',
  'Time.fun',
  'Madness',
  'Believe',
  'Moonshot',
  'Bags',
  'Jupiter Studio',
  'DaosFun',
  'Peek.fun',
  'Coined.wtf',
  'Candle',
  'Trends',
  'Oneshot.meme',
  'Boop',
  'Slerfpad',
  'Dealr.fun',
  'Sendshot',
  'Forge',
  'Dubdub',
  'Opinions.fun',
  'Subs.fun'
];

// Форматирование чисел
/**
 * Показать уведомление об успешном закрытии позиции
 */
function showSuccessNotification(title, message, signature) {
  // Создаем контейнер для уведомлений, если его еще нет
  let notificationContainer = document.getElementById('notificationContainer');
  if (!notificationContainer) {
    notificationContainer = document.createElement('div');
    notificationContainer.id = 'notificationContainer';
    notificationContainer.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 400px;
    `;
    document.body.appendChild(notificationContainer);
  }

  // Создаем элемент уведомления
  const notification = document.createElement('div');
  notification.style.cssText = `
    background: linear-gradient(135deg, rgba(76, 175, 80, 0.95) 0%, rgba(56, 142, 60, 0.95) 100%);
    border: 2px solid rgba(76, 175, 80, 0.8);
    border-radius: 12px;
    padding: 20px;
    color: white;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    animation: slideInRight 0.3s ease-out;
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  `;

  // Добавляем анимацию появления
  if (!document.getElementById('notificationStyles')) {
    const style = document.createElement('style');
    style.id = 'notificationStyles';
    style.textContent = `
      @keyframes slideInRight {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
      @keyframes slideOutRight {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(100%);
          opacity: 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  notification.innerHTML = `
    <div style="display: flex; align-items: flex-start; gap: 12px;">
      <div style="font-size: 24px; flex-shrink: 0;">✅</div>
      <div style="flex: 1;">
        <div style="font-weight: bold; font-size: 16px; margin-bottom: 8px;">${title}</div>
        <div style="font-size: 14px; opacity: 0.9; margin-bottom: 8px;">${message}</div>
        ${signature ? `
          <div style="font-size: 12px; opacity: 0.8; word-break: break-all; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.2);">
            <strong>Signature:</strong><br>
            <code style="background: rgba(0, 0, 0, 0.2); padding: 4px 6px; border-radius: 4px; font-family: monospace;">${signature}</code>
          </div>
        ` : ''}
      </div>
      <button style="
        background: rgba(255, 255, 255, 0.2);
        border: none;
        color: white;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        flex-shrink: 0;
        transition: background 0.2s;
      " onclick="this.parentElement.parentElement.remove()" title="Закрыть">×</button>
    </div>
  `;

  // Добавляем эффект при наведении
  notification.addEventListener('mouseenter', () => {
    notification.style.transform = 'translateX(-5px)';
    notification.style.boxShadow = '0 12px 40px rgba(0, 0, 0, 0.4)';
  });
  notification.addEventListener('mouseleave', () => {
    notification.style.transform = 'translateX(0)';
    notification.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
  });

  // Добавляем уведомление в контейнер
  notificationContainer.appendChild(notification);

  // Автоматически удаляем через 15 секунд
  setTimeout(() => {
    if (notification.parentElement) {
      notification.style.animation = 'slideOutRight 0.3s ease-out';
      setTimeout(() => {
        if (notification.parentElement) {
          notification.remove();
        }
      }, 300);
    }
  }, 15000);

  // При клике на уведомление открываем Solscan
  if (signature) {
    notification.addEventListener('click', (e) => {
      if (e.target.tagName !== 'BUTTON') {
        window.open(`https://solscan.io/tx/${signature}`, '_blank');
      }
    });
  }
}

function formatNumber(num) {
  if (num === 0 || !num) return '0';
  if (num < 0.01) return num.toExponential(2);
  if (num < 1000) return num.toFixed(2);
  if (num < 1000000) return (num / 1000).toFixed(2) + 'K';
  if (num < 1000000000) return (num / 1000000).toFixed(2) + 'M';
  return (num / 1000000000).toFixed(2) + 'B';
}

function formatCurrency(value) {
  if (!value || value === 0) return '$0';
  return '$' + formatNumber(value);
}

function formatPercent(value) {
  if (!value || value === 0) return '0%';
  return value.toFixed(2) + '%';
}

// Загрузка данных
async function loadPools(resetDisplayCount = true, showLoading = true) {
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const containerEl = document.getElementById('poolsContainer');
  
  if (showLoading) {
    loadingEl.style.display = 'block';
  }
  errorEl.style.display = 'none';
  
  // Очищаем контейнер только при полной перезагрузке
  if (resetDisplayCount) {
    containerEl.innerHTML = '';
  }
  
  try {
    console.log('📥 ========== ЗАГРУЗКА ПУЛОВ ==========');
    console.log('📥 Запрос к /api/pools...');
    const response = await fetch('/api/pools');
    if (!response.ok) throw new Error('Ошибка загрузки данных');
    
    const data = await response.json();
    const rawPoolsCount = Array.isArray(data) ? data.length : 0;
    console.log(`📥 Получено сырых данных: ${rawPoolsCount} пулов`);
    
    allPools = Array.isArray(data) ? data : [];
    
    // Фильтруем только активные пулы с ликвидностью
    const beforeFilter = allPools.length;
    allPools = allPools.filter(pool => {
      const hasLiquidity = parseFloat(pool.liquidity || 0) > 0;
      const isNotHidden = !pool.hide;
      const hasName = !!pool.name;
      return isNotHidden && hasLiquidity && hasName;
    });
    
    console.log(`🔍 После фильтрации (hide=false, liquidity>0, has name): ${beforeFilter} → ${allPools.length} пулов`);
    console.log(`   Отфильтровано: ${beforeFilter - allPools.length} пулов (${((beforeFilter - allPools.length) / beforeFilter * 100).toFixed(2)}%)`);
    
    // Показываем статистику загруженных данных
    if (allPools.length > 0) {
      const verifiedCount = allPools.filter(p => p.is_verified).length;
      const withLaunchpadCount = allPools.filter(p => p.launchpad && p.launchpad !== null && p.launchpad !== '').length;
      const lfgCount = allPools.filter(p => p.tags?.includes('lfg')).length;
      const withVolumeCount = allPools.filter(p => parseFloat(p.trade_volume_24h || 0) > 0).length;
      const withAprCount = allPools.filter(p => parseFloat(p.apr || 0) > 0).length;
      
      console.log('📊 Статистика загруженных данных:');
      console.log(`   - Verified: ${verifiedCount} (${(verifiedCount / allPools.length * 100).toFixed(2)}%)`);
      console.log(`   - С launchpad: ${withLaunchpadCount} (${(withLaunchpadCount / allPools.length * 100).toFixed(2)}%)`);
      console.log(`   - С LFG тегом: ${lfgCount} (${(lfgCount / allPools.length * 100).toFixed(2)}%)`);
      console.log(`   - С объемом за 24ч > 0: ${withVolumeCount} (${(withVolumeCount / allPools.length * 100).toFixed(2)}%)`);
      console.log(`   - С APR > 0: ${withAprCount} (${(withAprCount / allPools.length * 100).toFixed(2)}%)`);
      
      // Показываем примеры пулов с launchpad
      if (withLaunchpadCount > 0) {
        const launchpadPools = allPools.filter(p => p.launchpad && p.launchpad !== null && p.launchpad !== '').slice(0, 5);
        console.log('   Примеры пулов с launchpad:');
        launchpadPools.forEach(p => {
          console.log(`     - ${p.name}: launchpad="${p.launchpad}"`);
        });
      }
    }
    console.log('📥 ====================================');
    
    // Сбрасываем счетчик отображения только при ручном обновлении
    if (resetDisplayCount) {
      displayedCount = POOLS_PER_PAGE;
    }
    
    updateStats();
    applyFilters();
    
    if (showLoading) {
      loadingEl.style.display = 'none';
    }
  } catch (error) {
    console.error('❌ Ошибка загрузки пулов:', error);
    if (showLoading) {
      loadingEl.style.display = 'none';
    }
    errorEl.textContent = 'Ошибка загрузки данных: ' + error.message;
    errorEl.style.display = 'block';
  }
}

// Ручное обновление (с кнопки)
function refreshPools() {
  loadPools(true, true); // Сбрасываем счетчик и показываем загрузку
  updateAutoRefreshInfo(); // Сбрасываем таймер автообновления
}

// Автообновление (фоновое, без сброса позиции)
function autoRefreshPools() {
  loadPools(false, false); // Не сбрасываем счетчик, не показываем загрузку
  updateAutoRefreshInfo();
}

// Обновление информации об автообновлении
function updateAutoRefreshInfo() {
  const infoEl = document.getElementById('autoRefreshInfo');
  if (!infoEl) return;
  
  // Очищаем предыдущий таймер, если есть
  if (refreshInfoTimer) {
    clearInterval(refreshInfoTimer);
  }
  
  nextRefreshTime = Date.now() + AUTO_REFRESH_INTERVAL;
  
  // Обновляем каждую секунду
  refreshInfoTimer = setInterval(() => {
    if (!nextRefreshTime) return;
    
    const timeLeft = Math.max(0, nextRefreshTime - Date.now());
    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);
    
    if (timeLeft > 0) {
      infoEl.textContent = `Автообновление через: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    } else {
      infoEl.textContent = 'Обновление...';
    }
  }, 1000);
  
  // Первое обновление сразу
  const timeLeft = Math.max(0, nextRefreshTime - Date.now());
  const minutes = Math.floor(timeLeft / 60000);
  const seconds = Math.floor((timeLeft % 60000) / 1000);
  infoEl.textContent = `Автообновление через: ${minutes}:${seconds.toString().padStart(2, '0')}`;
}

// Обновление статистики
function updateStats() {
  const totalPools = allPools.length;
  const totalLiquidity = allPools.reduce((sum, pool) => sum + parseFloat(pool.liquidity || 0), 0);
  const totalVolume = allPools.reduce((sum, pool) => sum + parseFloat(pool.trade_volume_24h || 0), 0);
  
  document.getElementById('totalPools').textContent = totalPools.toLocaleString();
  document.getElementById('totalLiquidity').textContent = formatCurrency(totalLiquidity);
  document.getElementById('totalVolume').textContent = formatCurrency(totalVolume);
  
  // Обновляем информационные блоки
  // Пока используем демо-данные, позже можно подключить реальные данные из API
  updateInfoBlocks();
  
  // Загружаем позиции
  loadPositions();
}

// Функция для обновления информационных блоков
async function updateInfoBlocks() {
  try {
    // Баланс позиций - считаем из активных позиций
    const positionBalance = 0; // TODO: получить из API позиций
    const positionBalanceSOL = 0;
    
    // Баланс кошелька - можно получить из localStorage если кошелек подключен
    const walletBalance = 0; // TODO: получить баланс кошелька
    const walletBalanceSOL = 0;
    
    // Невыкупленные комиссии
    const unclaimedFees = 0; // TODO: получить из позиций
    const unclaimedFeesSOL = 0;
    
    // Взысканные комиссии (исторические данные)
    const claimedFees = 0; // TODO: получить из истории
    const claimedFeesSOL = 0;
    
    // Обновляем UI
    document.getElementById('positionBalance').textContent = formatCurrency(positionBalance);
    document.getElementById('positionBalanceSOL').textContent = `${positionBalanceSOL.toFixed(6)} SOL`;
    
    document.getElementById('walletBalance').textContent = formatCurrency(walletBalance);
    document.getElementById('walletBalanceSOL').textContent = `${walletBalanceSOL.toFixed(6)} SOL`;
    
    document.getElementById('unclaimedFees').textContent = formatCurrency(unclaimedFees);
    document.getElementById('unclaimedFeesSOL').textContent = `${unclaimedFeesSOL.toFixed(6)} SOL`;
    
    document.getElementById('claimedFees').textContent = formatCurrency(claimedFees);
    document.getElementById('claimedFeesSOL').textContent = `${claimedFeesSOL.toFixed(6)} SOL`;
  } catch (error) {
    console.error('Error updating info blocks:', error);
  }
}

// Загрузка и отображение позиций
async function loadPositions() {
  const positionsContainer = document.getElementById('positionsContainer');
  const positionsCount = document.getElementById('positionsCount');
  
  if (!positionsContainer) {
    console.warn('positionsContainer not found');
    return;
  }
  
  try {
    // Пока используем тестовые данные для заглушки
    const now = new Date();
    const mockPositions = [
      {
        pair: '$LIGHT/SOL',
        timer: '01:53:32',
        openedAt: new Date(now.getTime() - (1 * 3600 + 53 * 60 + 32) * 1000).toISOString(),
        type: 'SPOT',
        bins: 100,
        baseFee: '2%',
        apr: '+3.8576%',
        volume: '$6.85M',
        tvl: '$1.35M',
        change24h: '+59.61%',
        pnlSol: '+0.0341',
        pnlUsd: '+$6.1337',
        value: '$187.63',
        roi: '+3.38%',
        initialLiquidityUsd: '$182',
        initialLiquiditySol: '0.504654',
        initialLiquidityToken: '457.131838',
        tokenName: '$LIGHT',
        currentLiquidityUsd: '$186',
        currentLiquiditySol: '0.550979',
        currentLiquidityToken: '409.001498',
        claimedFeesUsd: '$1.67',
        claimedFeesSol: '0.005834',
        claimedFeesToken: '3.001931',
        unclaimedFeesUsd: '$0.2113',
        unclaimedFeesSol: '0.000259',
        unclaimedFeesToken: '0.778042',
        stopLoss: '15%',
        stopLossEnabled: false,
        takeProfit: '25%',
        takeProfitEnabled: false,
        rebalance: 'Отключено',
        priceRange: {
          min: '0.00079721',
          current: '0.00114063',
          max: '0.00156830'
        }
      },
      {
        pair: 'CAESAR/SOL',
        timer: '00:26:04',
        openedAt: new Date(now.getTime() - (26 * 60 + 4) * 1000).toISOString(),
        type: 'SPOT',
        bins: 200,
        baseFee: '2%',
        apr: '+10.4318%',
        volume: '$719.1K',
        tvl: '$327.9K',
        change24h: '+405.48%',
        pnlSol: '+0.0111',
        pnlUsd: '+$2.05',
        value: '$91.63',
        roi: '+2.29%',
        initialLiquidityUsd: '$89.65',
        initialLiquiditySol: '0.25',
        initialLiquidityToken: '2,081.88761',
        tokenName: 'CAESAR',
        currentLiquidityUsd: '$91.63',
        currentLiquiditySol: '0.257751',
        currentLiquidityToken: '2,018.439883',
        claimedFeesUsd: '$0.0000',
        claimedFeesSol: '0',
        claimedFeesToken: '0',
        unclaimedFeesUsd: '$0.0275',
        unclaimedFeesSol: '0.000153',
        unclaimedFeesToken: '0',
        stopLoss: '15%',
        stopLossEnabled: true,
        takeProfit: '50%',
        takeProfitEnabled: true,
        rebalance: 'Отключено',
        priceRange: {
          min: '0.00006108',
          current: '0.00012216',
          max: '0.00023482'
        }
      }
    ];
    
    // Если есть подключенный кошелек, пытаемся загрузить реальные позиции
    let positions = mockPositions;
    if (walletPublicKey) {
      try {
        const response = await fetch(`/api/positions?userAddress=${encodeURIComponent(walletPublicKey)}`);
        if (response.ok) {
          const realPositions = await response.json();
          if (realPositions.length > 0) {
            // Конвертируем реальные позиции в формат для отображения
            positions = await Promise.all(realPositions.map(async (pos) => {
              // Загружаем детали позиции
              try {
                const detailsResponse = await fetch(`/api/positions/${pos.positionAddress}/details`);
                if (detailsResponse.ok) {
                  const details = await detailsResponse.json();
                  return convertPositionToDisplayFormat(details);
                }
              } catch (error) {
                console.error('Error loading position details:', error);
              }
              return convertPositionToDisplayFormat(pos);
            }));
          }
        }
      } catch (error) {
        console.error('Error loading real positions:', error);
        // Используем тестовые данные при ошибке
      }
    }
    
    // Обновляем счетчик
    if (positionsCount) {
      positionsCount.textContent = `${positions.length} активных позиций`;
    }
    
    // Отображаем позиции
    if (positions.length === 0) {
      positionsContainer.innerHTML = '<p style="color: rgba(255, 255, 255, 0.7); text-align: center; padding: 40px;">У вас нет открытых позиций</p>';
      return;
    }
    
    positionsContainer.innerHTML = positions.map((pos, index) => renderPosition(pos, index)).join('');
    
    // Обновляем таймеры каждую секунду
    if (window.positionTimerInterval) {
      clearInterval(window.positionTimerInterval);
    }
    window.positionTimerInterval = setInterval(() => {
      const timerElements = positionsContainer.querySelectorAll('.position-timer');
      timerElements.forEach((timerEl, index) => {
        if (positions[index] && positions[index].openedAt) {
          timerEl.textContent = formatTimer(positions[index].openedAt);
        }
      });
    }, 1000);
    
    // Добавляем обработчики для кнопок закрытия позиций
    positionsContainer.querySelectorAll('.close-position-main-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const positionAddress = btn.getAttribute('data-position-address');
        const poolAddress = btn.getAttribute('data-pool-address');
        if (positionAddress && poolAddress) {
          await closePosition(positionAddress, poolAddress);
        }
      });
    });
    
    // Добавляем обработчики для кнопок настроек позиций
    positionsContainer.querySelectorAll('.position-settings-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const positionAddress = btn.getAttribute('data-position-address');
        if (positionAddress) {
          openPositionSettingsModal(positionAddress);
        }
      });
    });
    
  } catch (error) {
    console.error('Error loading positions:', error);
    positionsContainer.innerHTML = '<p style="color: #ef4444; text-align: center; padding: 40px;">Ошибка загрузки позиций</p>';
  }
}

// Конвертация позиции в формат для отображения
function convertPositionToDisplayFormat(position) {
  // TODO: Реализовать конвертацию реальных данных позиции в формат отображения
  // Пока возвращаем базовую структуру
  return {
    pair: position.poolName || 'UNKNOWN/SOL',
    timer: formatTimer(position.openedAt),
    openedAt: position.openedAt,
    type: 'SPOT',
    bins: position.binStep || 100,
    baseFee: `${(position.baseFeePercentage || 0) * 100}%`,
    apr: position.apr ? `+${position.apr.toFixed(4)}%` : '+0%',
    volume: formatCurrency(position.volume24h || 0),
    tvl: formatCurrency(position.liquidity || 0),
    change24h: position.priceChangePercent ? `${position.priceChangePercent >= 0 ? '+' : ''}${position.priceChangePercent.toFixed(2)}%` : '+0%',
    pnlSol: position.pnlSOL ? `${position.pnlSOL >= 0 ? '+' : ''}${position.pnlSOL.toFixed(4)}` : '+0',
    pnlUsd: position.pnlUSD ? `${position.pnlUSD >= 0 ? '+' : ''}${formatCurrency(position.pnlUSD)}` : '+$0',
    value: formatCurrency(position.currentValueUSD || position.initialValueUSD || 0),
    roi: position.roiPercent ? `${position.roiPercent >= 0 ? '+' : ''}${position.roiPercent.toFixed(2)}%` : '+0%',
    initialLiquidityUsd: formatCurrency(position.initialValueUSD || 0),
    initialLiquiditySol: (position.initialTokenXAmount || 0).toFixed(6),
    initialLiquidityToken: (position.initialTokenYAmount || 0).toFixed(6),
    currentLiquidityUsd: formatCurrency(position.currentValueUSD || position.initialValueUSD || 0),
    currentLiquiditySol: (position.tokenXAmount || position.initialTokenXAmount || 0).toFixed(6),
    currentLiquidityToken: (position.tokenYAmount || position.initialTokenYAmount || 0).toFixed(6),
    claimedFeesUsd: formatCurrency(position.accumulatedFees || 0),
    claimedFeesSol: '0',
    claimedFeesToken: '0',
    unclaimedFeesUsd: formatCurrency(position.unclaimedFees || 0),
    unclaimedFeesSol: '0',
    unclaimedFeesToken: '0',
    stopLoss: position.stopLossPercent ? `${position.stopLossPercent}%` : '15%',
    stopLossEnabled: position.stopLossEnabled !== false,
    takeProfit: position.takeProfitPercent ? `${position.takeProfitPercent}%` : '25%',
    takeProfitEnabled: position.takeProfitEnabled !== false,
    rebalance: position.rebalanceEnabled ? 'Включено' : 'Отключено',
    priceRange: {
      min: (position.lowerPrice || 0).toFixed(8),
      current: (position.currentPrice || position.initialPrice || 0).toFixed(8),
      max: (position.upperPrice || 0).toFixed(8)
    },
    positionAddress: position.positionAddress,
    poolAddress: position.poolAddress,
    autoClaim: position.autoClaim
  };
}

// Форматирование таймера
function formatTimer(openedAt) {
  if (!openedAt) return '00:00:00';
  const now = new Date();
  const opened = new Date(openedAt);
  const diff = Math.floor((now - opened) / 1000);
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  const seconds = diff % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Рендеринг позиции
function renderPosition(pos, index) {
  const change24hClass = pos.change24h.startsWith('+') ? 'positive' : 'negative';
  
  // Вычисляем позицию текущей цены в диапазоне для графика
  const minPrice = parseFloat(pos.priceRange.min);
  const maxPrice = parseFloat(pos.priceRange.max);
  const currentPrice = parseFloat(pos.priceRange.current);
  const range = maxPrice - minPrice;
  const currentPosition = range > 0 ? ((currentPrice - minPrice) / range) * 100 : 50;
  
  return `
    <div class="position-card-new" data-position-address="${pos.positionAddress || ''}" data-pool-address="${pos.poolAddress || ''}">
      <div class="position-header">
        <div class="position-pair-name">${pos.pair}</div>
        <div style="display: flex; align-items: center; gap: 10px;">
          <div class="position-timer">${pos.timer}</div>
          <button 
            class="position-settings-btn" 
            data-position-address="${pos.positionAddress || ''}"
            style="background: rgba(102, 126, 234, 0.2); border: 1px solid rgba(102, 126, 234, 0.4); border-radius: 6px; padding: 6px 10px; cursor: pointer; color: #667eea; font-size: 16px; transition: all 0.2s;"
            onmouseover="this.style.background='rgba(102, 126, 234, 0.3)'"
            onmouseout="this.style.background='rgba(102, 126, 234, 0.2)'"
            title="Настройки позиции"
          >
            ⚙️
          </button>
        </div>
      </div>
      
      <div class="position-metrics-row">
        <span class="position-metric-text">${pos.type} • ${pos.bins} bins • BASE FEE ${pos.baseFee} • <span class="positive">${pos.apr} APR</span></span>
        <span class="position-metric-text">Vol: ${pos.volume} • TVL: ${pos.tvl} • <span class="${change24hClass}">${pos.change24h} (24h)</span></span>
      </div>
      
      <div class="position-pnl">
        <div class="position-pnl-main">
          <span class="position-pnl-sol">${pos.pnlSol} SOL</span>
          <span class="position-pnl-usd">${pos.pnlUsd}</span>
        </div>
        <div class="position-pnl-details">
          <span class="position-pnl-value">ЗНАЧЕНИЕ: ${pos.value}</span>
          <span class="position-pnl-roi">ROI: ${pos.roi}</span>
        </div>
      </div>
      
      <div class="position-details-grid">
        <div class="position-detail-block">
          <div class="position-detail-title">ВХОДНАЯ ЛИКВИДНОСТЬ (${pos.initialLiquidityUsd})</div>
          <div class="position-detail-item">
            <span class="position-detail-label">SOL:</span>
            <span class="position-detail-value">${pos.initialLiquiditySol}</span>
          </div>
          <div class="position-detail-item">
            <span class="position-detail-label">${pos.tokenName || pos.pair.split('/')[0]}:</span>
            <span class="position-detail-value">${pos.initialLiquidityToken}</span>
          </div>
        </div>
        
        <div class="position-detail-block">
          <div class="position-detail-title">ТЕКУЩАЯ ЛИКВИДНОСТЬ (${pos.currentLiquidityUsd})</div>
          <div class="position-detail-item">
            <span class="position-detail-label">SOL:</span>
            <span class="position-detail-value">${pos.currentLiquiditySol}</span>
          </div>
          <div class="position-detail-item">
            <span class="position-detail-label">${pos.tokenName || pos.pair.split('/')[0]}:</span>
            <span class="position-detail-value">${pos.currentLiquidityToken}</span>
          </div>
        </div>
        
        <div class="position-detail-block">
          <div class="position-detail-title">КОМИССИИ ВЗЫСКАНЫ (${pos.claimedFeesUsd})</div>
          <div class="position-detail-item">
            <span class="position-detail-label">SOL:</span>
            <span class="position-detail-value">${pos.claimedFeesSol}</span>
          </div>
          <div class="position-detail-item">
            <span class="position-detail-label">${pos.tokenName || pos.pair.split('/')[0]}:</span>
            <span class="position-detail-value">${pos.claimedFeesToken}</span>
          </div>
        </div>
        
        <div class="position-detail-block">
          <div class="position-detail-title">КОМИССИИ НЕ ВЗЫСКАНЫ (${pos.unclaimedFeesUsd})</div>
          <div class="position-detail-item">
            <span class="position-detail-label">SOL:</span>
            <span class="position-detail-value">${pos.unclaimedFeesSol}</span>
          </div>
          <div class="position-detail-item">
            <span class="position-detail-label">${pos.tokenName || pos.pair.split('/')[0]}:</span>
            <span class="position-detail-value">${pos.unclaimedFeesToken}</span>
          </div>
        </div>
      </div>
      
      <div class="position-price-range">
        <div class="price-range-container">
          <div class="price-range-bar">
            <div class="price-range-gradient"></div>
            <div class="price-range-line-wrapper" style="left: ${currentPosition}%;">
              <div class="price-range-marker price-range-marker-top"></div>
              <div class="price-range-line"></div>
              <div class="price-range-marker price-range-marker-bottom"></div>
              <div class="price-range-current-value">${pos.priceRange.current}</div>
            </div>
          </div>
          <div class="price-range-labels">
            <span class="price-range-label price-range-label-min">${pos.priceRange.min}</span>
            <span class="price-range-label price-range-label-max">${pos.priceRange.max}</span>
          </div>
        </div>
      </div>
      
      <!-- Кнопки управления позицией -->
      <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; gap: 10px;">
        <button 
          class="close-position-main-btn" 
          data-position-address="${pos.positionAddress || ''}"
          data-pool-address="${pos.poolAddress || ''}"
          style="flex: 1; padding: 12px; background: linear-gradient(135deg, #2a2a2a 0%, #4a4a4a 100%); color: white; border: 2px solid #1e3a5f; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.95em; transition: all 0.3s ease;"
          onmouseover="this.style.opacity='0.9'; this.style.transform='scale(1.02)'; this.style.borderColor='#2d5a8a'"
          onmouseout="this.style.opacity='1'; this.style.transform='scale(1)'; this.style.borderColor='#1e3a5f'"
        >
          🔒 Закрыть позицию
        </button>
      </div>
    </div>
  `;
}

// Применение фильтров и сортировки
function applyFilters() {
  console.log('🔍 ========== НАЧАЛО ФИЛЬТРАЦИИ ==========');
  console.log('📊 Всего пулов в базе:', allPools.length);
  
  const searchInputEl = document.getElementById('searchInput');
  const sortSelectEl = document.getElementById('sortSelect');
  const searchTerm = searchInputEl ? searchInputEl.value.toLowerCase() : '';
  const sortValue = sortSelectEl ? sortSelectEl.value : 'liquidity-desc';
  
  console.log('🔎 Поисковый запрос:', searchTerm || '(пусто)');
  console.log('📋 Текущие фильтры:', JSON.stringify(filters, null, 2));
  
  // Начинаем с всех пулов
  let poolsToFilter = allPools;
  console.log('📥 Начальное количество пулов:', poolsToFilter.length);
  
  // Фильтрация по поиску (если есть поисковый запрос)
  if (searchTerm) {
    const beforeSearch = poolsToFilter.length;
    poolsToFilter = poolsToFilter.filter(pool => {
      const name = (pool.name || '').toLowerCase();
      const address = (pool.address || '').toLowerCase();
      return name.includes(searchTerm) || address.includes(searchTerm);
    });
    console.log(`🔎 После поиска "${searchTerm}": ${beforeSearch} → ${poolsToFilter.length} пулов`);
  }
  
  // МИНИМАЛЬНЫЙ ФИЛЬТР ПО УМОЛЧАНИЮ: Volume 24H >= TVL
  // Это критически важно - на пулах где объем меньше ликвидности мы будем терять деньги
  const beforeMinFilter = poolsToFilter.length;
  poolsToFilter = poolsToFilter.filter((pool) => {
    const volume24h = parseFloat(pool.trade_volume_24h || pool.volume?.hour_24 || 0);
    const liquidity = parseFloat(pool.liquidity || 0);
    
    // Если ликвидность = 0, пропускаем пул
    if (liquidity === 0) {
      return false;
    }
    
    // Объем за 24ч должен быть >= TVL (ликвидности)
    return volume24h >= liquidity;
  });
  console.log(`⚡ Минимальный фильтр (Volume 24H >= TVL): ${beforeMinFilter} → ${poolsToFilter.length} пулов`);
  
  // Применяем дополнительные фильтры
  filteredPools = poolsToFilter.filter((pool) => {
    
    // Verified filter
    if (filters.verified) {
      if (!pool.is_verified) {
        return false;
      }
    }
    
    // Channel width filter - проверяем, подходит ли bin step для заданной ширины канала
    if (filters.channelWidth !== null && filters.channelWidth > 0) {
      const rangeInterval = 10; // Стандартное значение rangeInterval для позиции
      const channelWidthTotal = filters.channelWidth * 2; // Общая ширина канала (вверх + вниз) в процентах
      const totalBins = rangeInterval * 2; // Общее количество бинов в диапазоне (20)
      
      // Минимальный bin_step, необходимый для достижения заданной ширины канала
      // В Meteora DLMM: price_change_per_bin = bin_step / 10000 (в долях)
      // Для totalBins бинов: общий диапазон = totalBins * (bin_step / 10000) * 100 (в процентах)
      // Нужно: totalBins * (bin_step / 10000) * 100 >= channelWidthTotal
      // Отсюда: bin_step >= (channelWidthTotal / totalBins) * 100
      // Пример: для 4% и 20 бинов: bin_step >= (4 / 20) * 100 = 20
      const minBinStepRequired = (channelWidthTotal / totalBins) * 100;
      
      const binStep = parseFloat(pool.bin_step || 0);
      if (binStep < minBinStepRequired) {
        return false;
      }
    }
    
    // Bin step range
    if (filters.binStepMin !== null || filters.binStepMax !== null) {
      const binStep = parseFloat(pool.bin_step || 0);
      if (filters.binStepMin !== null && binStep < filters.binStepMin) {
        return false;
      }
      if (filters.binStepMax !== null && binStep > filters.binStepMax) {
        return false;
      }
    }
    
    // Liquidity range
    if (filters.liquidityMin !== null || filters.liquidityMax !== null) {
      const liquidity = parseFloat(pool.liquidity || 0);
      if (filters.liquidityMin !== null && liquidity < filters.liquidityMin) {
        return false;
      }
      if (filters.liquidityMax !== null && liquidity > filters.liquidityMax) {
        return false;
      }
    }
    
    // Volume by period - применяем только если указан минимум > 0
    if (filters.volumePeriodMin !== null && filters.volumePeriodMin > 0) {
      const volume = parseFloat(pool.volume?.[filters.volumePeriod] || pool.trade_volume_24h || 0);
      if (volume < filters.volumePeriodMin) {
        return false;
      }
    }
    
    // Fees by period - применяем только если указан минимум > 0
    if (filters.feesPeriodMin !== null && filters.feesPeriodMin > 0) {
      const fees = parseFloat(pool.fees?.[filters.feesPeriod] || pool.fees_24h || 0);
      if (fees < filters.feesPeriodMin) {
        return false;
      }
    }
    
    // Fees 24h range - фильтрация по комиссиям за 24 часа
    if (filters.fees24hMin !== null || filters.fees24hMax !== null) {
      const fees24h = parseFloat(pool.fees_24h || pool.fees?.hour_24 || 0);
      if (filters.fees24hMin !== null && fees24h < filters.fees24hMin) {
        return false;
      }
      if (filters.fees24hMax !== null && fees24h > filters.fees24hMax) {
        return false;
      }
    }
    
    // Fee/TVL % by period - применяем только если указан минимум > 0
    if (filters.feeTvlPeriodMin !== null && filters.feeTvlPeriodMin > 0) {
      const feeTvl = parseFloat(pool.fee_tvl_ratio?.[filters.feeTvlPeriod] || 0) * 100; // конвертируем в проценты
      if (feeTvl < filters.feeTvlPeriodMin) {
        return false;
      }
    }
    
    // APR range
    if (filters.aprMin !== null || filters.aprMax !== null) {
      const apr = parseFloat(pool.apr || 0);
      if (filters.aprMin !== null && apr < filters.aprMin) {
        return false;
      }
      if (filters.aprMax !== null && apr > filters.aprMax) {
        return false;
      }
    }
    
    // Launchpad filter - если выбраны launchpad, показываем ТОЛЬКО пулы с выбранными launchpad
    if (filters.launchpads.length > 0) {
      // Получаем launchpad из пула (может быть в поле launchpad или определяем по другим признакам)
      let poolLaunchpad = pool.launchpad;
      
      // Если launchpad не указан в данных, пытаемся определить по другим признакам
      // (например, по адресу токена или названию)
      if (!poolLaunchpad || poolLaunchpad === null || poolLaunchpad === '') {
        // Пока что, если в данных нет launchpad, исключаем пул
        // В будущем здесь можно добавить логику определения launchpad по адресу токена
        return false;
      }
      
      // Строгое сравнение launchpad (точное совпадение с нормализацией регистра и точек)
      const poolLaunchpadLower = String(poolLaunchpad).toLowerCase().trim();
      const matchesLaunchpad = filters.launchpads.some(selectedLp => {
        const selectedLpLower = selectedLp.toLowerCase().trim();
        
        // Точное совпадение (с учетом того, что могут быть разные варианты написания)
        if (poolLaunchpadLower === selectedLpLower) return true;
        
        // Нормализация: убираем точки и пробелы для сравнения
        // "time.fun" === "Time.fun" === "time fun"
        const normalize = (str) => str.replace(/[.\s-_]/g, '').toLowerCase();
        const normalizedPool = normalize(poolLaunchpadLower);
        const normalizedSelected = normalize(selectedLpLower);
        
        if (normalizedPool === normalizedSelected) return true;
        
        // Дополнительная проверка: "timefun" должно совпадать с "Time.fun"
        // Но "pumpfun" НЕ должно совпадать с "timefun"
        return false;
      });
      
      // Если launchpad не совпадает - исключаем
      if (!matchesLaunchpad) {
        return false;
      }
    }
    
    // LFG tag filter
    if (filters.lfg) {
      if (!pool.tags?.includes('lfg')) {
        return false;
      }
    }
    
    return true;
  });
  
  // Подробная статистика фильтрации
  console.log('📊 ========== СТАТИСТИКА ФИЛЬТРАЦИИ ==========');
  console.log(`✅ После всех фильтров: ${poolsToFilter.length} → ${filteredPools.length} пулов`);
  console.log(`📉 Отфильтровано: ${poolsToFilter.length - filteredPools.length} пулов (${((poolsToFilter.length - filteredPools.length) / poolsToFilter.length * 100).toFixed(2)}%)`);
  
  // Подсчитываем статистику по каждому фильтру
  if (filters.channelWidth !== null && filters.channelWidth > 0) {
    const rangeInterval = 10;
    const channelWidthTotal = filters.channelWidth * 2;
    const totalBins = rangeInterval * 2;
    const minBinStepRequired = (channelWidthTotal / totalBins) * 100;
    const matchingCount = poolsToFilter.filter(p => {
      const binStep = parseFloat(p.bin_step || 0);
      return binStep >= minBinStepRequired;
    }).length;
    console.log(`📏 Фильтр по ширине канала: ${filters.channelWidth}% (общая ${channelWidthTotal}%)`);
    console.log(`   - Требуется min bin_step: ${minBinStepRequired.toFixed(2)}`);
    console.log(`   - Подходящих пулов: ${matchingCount} из ${poolsToFilter.length}`);
  }
  
  if (filters.verified) {
    const verifiedCount = poolsToFilter.filter(p => p.is_verified).length;
    console.log(`✅ Verified фильтр: ${verifiedCount} verified пулов из ${poolsToFilter.length}`);
  }
  
  if (filters.launchpads.length > 0) {
    const normalize = (str) => str.replace(/[.\s-_]/g, '').toLowerCase();
    
    const withLaunchpad = poolsToFilter.filter(p => p.launchpad && p.launchpad !== null && p.launchpad !== '').length;
    const matchingLaunchpad = poolsToFilter.filter(p => {
      if (!p.launchpad || p.launchpad === null || p.launchpad === '') return false;
      const lpName = String(p.launchpad).toLowerCase().trim();
      return filters.launchpads.some(lp => {
        const lpLower = lp.toLowerCase().trim();
        // Строгое сравнение: точное совпадение или нормализованное совпадение
        return lpName === lpLower || normalize(lpName) === normalize(lpLower);
      });
    }).length;
    console.log(`🚀 Launchpad фильтр: выбрано ${filters.launchpads.length} launchpad (${filters.launchpads.join(', ')})`);
    console.log(`   - Всего пулов с любым launchpad в данных: ${withLaunchpad}`);
    console.log(`   - Пулов с ВЫБРАННЫМИ launchpad (будут показаны): ${matchingLaunchpad}`);
    console.log(`   - Пулов БЕЗ launchpad (будут ИСКЛЮЧЕНЫ): ${poolsToFilter.length - withLaunchpad}`);
    
    // Показываем примеры пулов с выбранными launchpad
    if (matchingLaunchpad > 0) {
      const matchingPools = poolsToFilter.filter(p => {
        if (!p.launchpad || p.launchpad === null || p.launchpad === '') return false;
        const lpName = String(p.launchpad).toLowerCase().trim();
        return filters.launchpads.some(lp => {
          const lpLower = lp.toLowerCase().trim();
          return lpName === lpLower || normalize(lpName) === normalize(lpLower);
        });
      }).slice(0, 5);
      console.log(`   ✅ Примеры пулов с выбранными launchpad:`);
      matchingPools.forEach(p => {
        console.log(`     - ${p.name}: launchpad="${p.launchpad}"`);
      });
    } else {
      console.log(`   ⚠️  НЕТ пулов с выбранными launchpad в данных API!`);
      console.log(`   💡 Проблема: API содержит launchpad только для ${withLaunchpad} пулов из ${poolsToFilter.length}`);
      // Показываем, какие launchpad есть в данных
      const allLaunchpads = new Set();
      poolsToFilter.forEach(p => {
        if (p.launchpad && p.launchpad !== null && p.launchpad !== '') {
          allLaunchpads.add(p.launchpad);
        }
      });
      if (allLaunchpads.size > 0) {
        console.log(`   📋 Доступные launchpad в данных API:`, Array.from(allLaunchpads));
        console.log(`   💡 На Meteora могут использоваться другие данные или способ определения launchpad`);
      } else {
        console.log(`   ⚠️  В данных API НЕТ информации о launchpad для ни одного пула!`);
      }
    }
  }
  
  if (filters.lfg) {
    const lfgCount = poolsToFilter.filter(p => p.tags?.includes('lfg')).length;
    console.log(`🏷️  LFG фильтр: ${lfgCount} пулов с LFG тегом`);
  }
  
  if (filters.liquidityMin !== null || filters.liquidityMax !== null) {
    const liquidityFiltered = poolsToFilter.filter(p => {
      const liq = parseFloat(p.liquidity || 0);
      if (filters.liquidityMin !== null && liq < filters.liquidityMin) return false;
      if (filters.liquidityMax !== null && liq > filters.liquidityMax) return false;
      return true;
    }).length;
    console.log(`💧 Liquidity фильтр: ${liquidityFiltered} пулов соответствуют диапазону`);
  }
  
  if (filters.volumePeriodMin !== null && filters.volumePeriodMin > 0) {
    const volumeFiltered = poolsToFilter.filter(p => {
      const vol = parseFloat(p.volume?.[filters.volumePeriod] || p.trade_volume_24h || 0);
      return vol >= filters.volumePeriodMin;
    }).length;
    console.log(`📈 Volume фильтр (${filters.volumePeriod}, мин: ${filters.volumePeriodMin}): ${volumeFiltered} пулов`);
  }
  
  if (filters.aprMin !== null || filters.aprMax !== null) {
    const aprFiltered = poolsToFilter.filter(p => {
      const apr = parseFloat(p.apr || 0);
      if (filters.aprMin !== null && apr < filters.aprMin) return false;
      if (filters.aprMax !== null && apr > filters.aprMax) return false;
      return true;
    }).length;
    console.log(`💰 APR фильтр: ${aprFiltered} пулов соответствуют диапазону`);
  }
  
  // Показываем первые 5 отфильтрованных пулов для отладки
  if (filteredPools.length > 0) {
    console.log(`📋 Первые ${Math.min(5, filteredPools.length)} отфильтрованных пулов (всего ${filteredPools.length}):`);
    const normalize = (str) => str.replace(/[.\s-_]/g, '').toLowerCase();
    filteredPools.slice(0, 5).forEach((pool, idx) => {
      console.log(`   ${idx + 1}. ${pool.name} (${pool.address?.substring(0, 8)}...) - verified: ${pool.is_verified}, launchpad: ${pool.launchpad || 'нет'}, liquidity: ${pool.liquidity}`);
      
      // Проверяем, почему этот пул прошел фильтры
      if (filters.launchpads.length > 0) {
        if (!pool.launchpad || pool.launchpad === null || pool.launchpad === '') {
          console.log(`      ⚠️  БАГ: Этот пул прошел фильтр по launchpad, но у него нет launchpad!`);
        } else {
          const poolLp = String(pool.launchpad).toLowerCase().trim();
          const matches = filters.launchpads.some(lp => {
            const lpLower = lp.toLowerCase().trim();
            return poolLp === lpLower || normalize(poolLp) === normalize(lpLower);
          });
          if (!matches) {
            console.log(`      ⚠️  БАГ: Пула прошел фильтр, но launchpad "${pool.launchpad}" не совпадает с "${filters.launchpads.join(', ')}"!`);
          } else {
            console.log(`      ✅ Launchpad совпадает: "${pool.launchpad}" === "${filters.launchpads.join(' или ')}"`);
          }
        }
      }
    });
  } else {
    console.log('❌ Нет пулов, соответствующих фильтрам!');
    
      // Показываем, почему пулы не прошли фильтры (пример первых 10)
      console.log('🔍 Анализ первых 10 пулов, почему они не прошли:');
      const normalize = (str) => str.replace(/[.\s-_]/g, '').toLowerCase();
      poolsToFilter.slice(0, 10).forEach((pool, idx) => {
        const reasons = [];
        if (filters.verified && !pool.is_verified) reasons.push('не verified');
        if (filters.launchpads.length > 0) {
          if (!pool.launchpad || pool.launchpad === null || pool.launchpad === '') {
            reasons.push('нет launchpad в данных');
          } else {
            const lpName = String(pool.launchpad).toLowerCase().trim();
            const matches = filters.launchpads.some(lp => {
              const lpLower = lp.toLowerCase().trim();
              return lpName === lpLower || normalize(lpName) === normalize(lpLower);
            });
            if (!matches) reasons.push(`launchpad "${pool.launchpad}" не совпадает с выбранными "${filters.launchpads.join(', ')}"`);
          }
        }
        if (filters.lfg && !pool.tags?.includes('lfg')) reasons.push('нет LFG тега');
        if (filters.liquidityMin !== null && parseFloat(pool.liquidity || 0) < filters.liquidityMin) {
          reasons.push(`ликвидность ${pool.liquidity} < ${filters.liquidityMin}`);
        }
        if (filters.volumePeriodMin !== null && filters.volumePeriodMin > 0) {
          const vol = parseFloat(pool.volume?.[filters.volumePeriod] || pool.trade_volume_24h || 0);
          if (vol < filters.volumePeriodMin) reasons.push(`volume ${vol} < ${filters.volumePeriodMin}`);
        }
        
        console.log(`   ${idx + 1}. ${pool.name}: ${reasons.length > 0 ? reasons.join(', ') : '⚠️ должен был быть исключен, но прошел фильтры (баг!)'}`);
      });
  }
  
  console.log('🔍 ========== КОНЕЦ ФИЛЬТРАЦИИ ==========');
  
  // Сортировка
  const [sortBy, order] = sortValue.split('-');
  filteredPools.sort((a, b) => {
    let aVal, bVal;
    
    switch(sortBy) {
      case 'liquidity':
        aVal = parseFloat(a.liquidity || 0);
        bVal = parseFloat(b.liquidity || 0);
        break;
      case 'volume':
        aVal = parseFloat(a.trade_volume_24h || 0);
        bVal = parseFloat(b.trade_volume_24h || 0);
        break;
      case 'fees':
        aVal = parseFloat(a.fees_24h || a.fees?.hour_24 || 0);
        bVal = parseFloat(b.fees_24h || b.fees?.hour_24 || 0);
        break;
      case 'apr':
        aVal = parseFloat(a.apr || 0);
        bVal = parseFloat(b.apr || 0);
        break;
      default:
        return 0;
    }
    
    return order === 'desc' ? bVal - aVal : aVal - bVal;
  });
  
  // Сбрасываем счетчик при изменении фильтров
  displayedCount = POOLS_PER_PAGE;
  
  renderPools();
}

// Отрисовка пулов
function renderPools() {
  console.log('🎨 Rendering pools...', { filteredCount: filteredPools.length, displayedCount });
  const containerEl = document.getElementById('poolsContainer');
  const loadMoreContainer = document.getElementById('loadMoreContainer');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const poolsInfo = document.getElementById('poolsInfo');
  
  if (filteredPools.length === 0) {
    const hasActiveFilters = 
      filters.verified ||
      filters.binStepMin !== null ||
      filters.binStepMax !== null ||
      filters.liquidityMin !== null ||
      filters.liquidityMax !== null ||
      filters.volumePeriodMin !== null ||
      filters.feesPeriodMin !== null ||
      filters.fees24hMin !== null ||
      filters.fees24hMax !== null ||
      filters.feeTvlPeriodMin !== null ||
      filters.aprMin !== null ||
      filters.aprMax !== null ||
      filters.launchpads.length > 0 ||
      filters.lfg;
    
    if (hasActiveFilters) {
      const hasLaunchpadFilter = filters.launchpads.length > 0;
      const hasVolumeFilter = filters.volumePeriodMin !== null && filters.volumePeriodMin > 0;
      const hasFeesFilter = filters.feesPeriodMin !== null && filters.feesPeriodMin > 0;
      const hasAprFilter = filters.aprMin !== null && filters.aprMin > 0;
      
      let tips = [];
      if (hasLaunchpadFilter) {
        tips.push('• Фильтр по launchpad: API Meteora содержит информацию о launchpad только для очень малого количества пулов. Большинство пулов не имеют поля launchpad в данных API.');
        tips.push('• Это ограничение API, а не ошибка фильтрации. Meteora может использовать другой источник данных для определения launchpad на своем сайте.');
      }
      if (hasVolumeFilter || hasFeesFilter) {
        tips.push('• Фильтры по объемам/комиссиям: только ~1.8% пулов имеют активность за 24ч. Попробуйте уменьшить значение фильтра.');
      }
      if (hasAprFilter) {
        tips.push('• Фильтр по APR: только ~1.8% пулов имеют APR > 0. Попробуйте уменьшить значение фильтра.');
      }
      if (tips.length === 0) {
        tips.push('Попробуйте убрать некоторые фильтры или изменить их значения');
      }
      
      containerEl.innerHTML = `
        <div class="error" style="text-align: center; padding: 40px; max-width: 600px; margin: 0 auto;">
          <div style="font-size: 1.2em; margin-bottom: 15px; font-weight: bold;">Пулы не найдены</div>
          <div style="font-size: 0.9em; opacity: 0.9; line-height: 1.6;">
            ${tips.join('<br/>')}
            <br/><br/>
            <strong>Совет:</strong> Начните с одного фильтра и постепенно добавляйте другие, чтобы увидеть результаты.
          </div>
        </div>
      `;
    } else {
      containerEl.innerHTML = '<div class="error">Пулы не найдены</div>';
    }
    loadMoreContainer.style.display = 'none';
    return;
  }
  
  // Группируем пулы по парам токенов
  const poolsByPair = new Map();
  
  filteredPools.forEach(pool => {
    const tokenXMint = pool.tokenXMint || pool.token_x?.mint || pool.mint_x || pool.base_mint || '';
    const tokenYMint = pool.tokenYMint || pool.token_y?.mint || pool.mint_y || pool.quote_mint || '';
    
    // Получаем названия токенов из разных возможных источников
    let tokenXName = pool.tokenX?.symbol || pool.token_x?.symbol || pool.tokenX?.name || pool.token_x?.name || '';
    let tokenYName = pool.tokenY?.symbol || pool.token_y?.symbol || pool.tokenY?.name || pool.token_y?.name || '';
    
    // Если названия не найдены, пытаемся извлечь из названия пула
    if (!tokenXName || !tokenYName) {
      if (pool.name) {
        // Пробуем разные разделители: -, /, пробел
        let parts = [];
        if (pool.name.includes('-')) {
          // Для формата "TOKEN-TOKEN" или "TOKEN-TOKEN/TOKEN"
          const firstPart = pool.name.split('/')[0]; // Берем часть до "/" если есть
          parts = firstPart.split('-');
        } else if (pool.name.includes('/')) {
          parts = pool.name.split('/');
        } else if (pool.name.includes(' ')) {
          parts = pool.name.split(' ');
        }
        
        if (parts.length >= 2) {
          if (!tokenXName) tokenXName = parts[0].trim();
          if (!tokenYName) tokenYName = parts[1].trim();
        }
      }
    }
    
    // Fallback если всё еще не найдены
    if (!tokenXName) tokenXName = 'Token X';
    if (!tokenYName) tokenYName = 'Token Y';
    
    // Создаем ключ для пары (нормализуем порядок токенов)
    const pairKey = tokenXMint && tokenYMint 
      ? [tokenXMint, tokenYMint].sort().join('|')
      : pool.address; // Если нет пары, используем адрес как ключ
    
    if (!poolsByPair.has(pairKey)) {
      poolsByPair.set(pairKey, {
        tokenXMint,
        tokenYMint,
        pools: [],
        tokenXName,
        tokenYName,
        isVerified: pool.is_verified || false,
        // Сохраняем первый пул для получения базовой информации
        firstPool: pool
      });
    }
    
    poolsByPair.get(pairKey).pools.push(pool);
  });
  
  // Преобразуем Map в массив и сортируем по общей ликвидности
  const pairsArray = Array.from(poolsByPair.values()).map(pair => {
    // Агрегируем данные по всем пулам пары
    const totalLiquidity = pair.pools.reduce((sum, p) => sum + parseFloat(p.liquidity || 0), 0);
    const totalVolume24h = pair.pools.reduce((sum, p) => sum + parseFloat(p.trade_volume_24h || p.volume?.hour_24 || 0), 0);
    const totalFees24h = pair.pools.reduce((sum, p) => sum + parseFloat(p.fees_24h || p.fees?.hour_24 || 0), 0);
    const maxApr = Math.max(...pair.pools.map(p => parseFloat(p.apr || 0)));
    const maxApy = Math.max(...pair.pools.map(p => parseFloat(p.apy || 0)));
    const binStepsCount = pair.pools.length;
    const price = parseFloat(pair.pools[0]?.price || pair.pools[0]?.current_price || pair.pools[0]?.price_usd || 0);
    
    return {
      ...pair,
      totalLiquidity,
      totalVolume24h,
      totalFees24h,
      maxApr,
      maxApy,
      binStepsCount,
      price
    };
  }).sort((a, b) => b.totalLiquidity - a.totalLiquidity);
  
  console.log(`📊 Создано ${pairsArray.length} пар из ${filteredPools.length} пулов`);
  
  // Отображаем только первые displayedCount пар
  const pairsToDisplay = pairsArray.slice(0, displayedCount);
  const hasMore = pairsArray.length > displayedCount;
  
  // Создаем таблицу пар
  const tableHtml = `
    <div class="pairs-table">
      <!-- Строка с фильтрами и сортировкой -->
      <div class="pairs-table-filters">
        <input type="text" id="searchInput" class="pairs-search-input" placeholder="Поиск по паре..." />
        <select id="sortSelect" class="pairs-sort-select">
          <option value="liquidity-desc">Ликвидность ↓</option>
          <option value="liquidity-asc">Ликвидность ↑</option>
          <option value="volume-desc">Объем 24ч ↓</option>
          <option value="volume-asc">Объем 24ч ↑</option>
          <option value="fees-desc">Комиссии 24ч ↓</option>
          <option value="fees-asc">Комиссии 24ч ↑</option>
          <option value="apr-desc">APR ↓</option>
          <option value="apr-asc">APR ↑</option>
        </select>
        <button id="filterBtn" class="pairs-filter-btn">🔍 Фильтр</button>
      </div>
      
      <div class="pairs-table-header">
        <div class="pairs-col pairs-col-num">#</div>
        <div class="pairs-col pairs-col-pair">Pair</div>
        <div class="pairs-col pairs-col-tvl">TVL</div>
        <div class="pairs-col pairs-col-volume">Volume 24H</div>
        <div class="pairs-col pairs-col-apr">Max APR</div>
      </div>
      ${pairsToDisplay.map((pair, pairIndex) => {
        // Формируем название пары
        let pairName = `${pair.tokenXName}/${pair.tokenYName}`;
        
        // Если названия не определены, пытаемся получить их из имени первого пула
        if ((pairName === 'Token X/Token Y' || pair.tokenXName === 'Token X' || pair.tokenYName === 'Token Y') && pair.firstPool?.name) {
          // Парсим название пула для получения названий токенов
          const poolName = pair.firstPool.name;
          if (poolName.includes('-')) {
            // Для формата "TOKEN-TOKEN" берем часть до "/" если есть
            const basePart = poolName.split('/')[0];
            const parts = basePart.split('-');
            if (parts.length >= 2) {
              pairName = `${parts[0].trim()}-${parts[1].trim()}`;
            } else {
              pairName = poolName.split('/')[0]; // Берем первую часть до "/"
            }
          } else if (poolName.includes('/')) {
            const parts = poolName.split('/');
            if (parts.length >= 2) {
              pairName = `${parts[0].trim()}/${parts[1].trim()}`;
            } else {
              pairName = poolName;
            }
          } else {
            pairName = poolName;
          }
        }
        
        // Логируем для отладки
        if (pairIndex < 5) {
          console.log(`Пара #${pairIndex}:`, {
            tokenXName: pair.tokenXName,
            tokenYName: pair.tokenYName,
            finalName: pairName,
            firstPoolName: pair.firstPool?.name
          });
        }
        
        // Сортируем пулы по bin step
        const sortedPools = [...pair.pools].sort((a, b) => {
          const binStepA = parseInt(a.bin_step || a.binStep || 0);
          const binStepB = parseInt(b.bin_step || b.binStep || 0);
          return binStepA - binStepB;
        });
        
        
        // Генерируем HTML для bin steps
        const binStepsHtml = sortedPools.map(pool => {
          const binStep = pool.bin_step || pool.binStep || '-';
    const liquidity = parseFloat(pool.liquidity || 0);
    const volume24h = parseFloat(pool.trade_volume_24h || pool.volume?.hour_24 || 0);
    const fees24h = parseFloat(pool.fees_24h || pool.fees?.hour_24 || 0);
    const apr = parseFloat(pool.apr || 0);
    const baseFee = parseFloat(pool.base_fee_percentage || pool.baseFee || pool.base_fee_bps || 0);
    
    return `
            <div class="bin-step-row" data-pool-address="${pool.address}">
              <div class="bin-step-col bin-step-num">
                <span class="bin-step-badge">Bin ${binStep}</span>
        </div>
              <div class="bin-step-col">
                <span class="bin-step-label">Fee</span>
                <span class="bin-step-value">${formatPercent(baseFee)}</span>
          </div>
              <div class="bin-step-col">
                <span class="bin-step-label">TVL</span>
                <span class="bin-step-value">${formatCurrency(liquidity)}</span>
          </div>
              <div class="bin-step-col">
                <span class="bin-step-label">Vol 24h</span>
                <span class="bin-step-value">${formatCurrency(volume24h)}</span>
          </div>
              <div class="bin-step-col">
                <span class="bin-step-label">Fee/TVL</span>
                <span class="bin-step-value">${fees24h > 0 && liquidity > 0 ? formatPercent((fees24h / liquidity) * 100) : '0%'}</span>
          </div>
              <div class="bin-step-col">
                <span class="bin-step-label">APR</span>
                <span class="bin-step-value apr-highlight">${apr > 0 ? formatPercent(apr) : '-'}</span>
          </div>
              <div class="bin-step-col bin-step-action">
                <button 
                  type="button" 
                  class="create-position-btn" 
                  data-pool-address="${pool.address}"
                  style="padding: 8px 16px; background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%); color: white; border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.3s;"
                  onmouseover="this.style.background='linear-gradient(135deg, #1a1a1a 0%, #252525 100%)'; this.style.borderColor='rgba(102, 126, 234, 0.5)'; this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 12px rgba(102, 126, 234, 0.2)'"
                  onmouseout="this.style.background='linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%)'; this.style.borderColor='rgba(102, 126, 234, 0.3)'; this.style.transform='translateY(0)'; this.style.boxShadow='none'"
                >
                  Открыть позицию
                </button>
            </div>
            </div>
          `;
        }).join('');
        
        return `
          <div class="pair-container" data-pair-index="${pairIndex}">
            <div class="pairs-table-row">
              <div class="pairs-col pairs-col-num">${pairIndex + 1}</div>
              <div class="pairs-col pairs-col-pair">
                <span class="pair-name">${pairName}</span>
                <span class="pair-pools-count">${pair.binStepsCount} pool${pair.binStepsCount > 1 ? 's' : ''}</span>
                ${pair.isVerified ? '<span class="pair-verified">✓</span>' : ''}
                <span class="expand-icon">▼</span>
        </div>
              <div class="pairs-col pairs-col-tvl">${formatCurrency(pair.totalLiquidity)}</div>
              <div class="pairs-col pairs-col-volume">${formatCurrency(pair.totalVolume24h)}</div>
              <div class="pairs-col pairs-col-apr">${pair.maxApr > 0 ? formatPercent(pair.maxApr) : '-'}</div>
          </div>
            
            <div class="bin-steps-list" style="display: none;">
              ${binStepsHtml}
          </div>
      </div>
    `;
      }).join('')}
    </div>
  `;
  
  containerEl.innerHTML = tableHtml;

  // Восстанавливаем значения поиска и сортировки
  const searchInput = containerEl.querySelector('#searchInput');
  const sortSelect = containerEl.querySelector('#sortSelect');
  
  // Сохраняем и восстанавливаем значение поиска
  if (searchInput) {
    const savedSearch = sessionStorage.getItem('poolsSearch') || '';
    searchInput.value = savedSearch;
  }
  
  // Сохраняем и восстанавливаем значение сортировки
  if (sortSelect) {
    const savedSort = sessionStorage.getItem('poolsSort') || 'liquidity-desc';
    sortSelect.value = savedSort;
  }

  // Добавляем обработчики клика для раскрытия/сворачивания bin steps
  containerEl.querySelectorAll('.pair-container').forEach((pairContainer) => {
    const tableRow = pairContainer.querySelector('.pairs-table-row');
    const binStepsList = pairContainer.querySelector('.bin-steps-list');
    const expandIcon = pairContainer.querySelector('.expand-icon');
    
    tableRow.addEventListener('click', (e) => {
      // Не открываем, если кликнули на verified badge
      if (e.target.closest('.pair-verified')) return;
      
      const isExpanded = binStepsList.style.display === 'block';
      
      if (isExpanded) {
        // Сворачиваем
        binStepsList.style.display = 'none';
        expandIcon.style.transform = 'rotate(0deg)';
        pairContainer.classList.remove('expanded');
      } else {
        // Разворачиваем
        binStepsList.style.display = 'block';
        expandIcon.style.transform = 'rotate(180deg)';
        pairContainer.classList.add('expanded');
      }
    });
    
    // Добавляем обработчики клика на кнопки "Создать позицию"
    binStepsList.querySelectorAll('.create-position-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Предотвращаем всплытие события
        const poolAddress = btn.getAttribute('data-pool-address');
        if (poolAddress) {
          openPoolModal(poolAddress);
        }
      });
    });
  });
  
  // Показываем/скрываем кнопку "Загрузить еще"
  if (hasMore) {
    loadMoreContainer.style.display = 'block';
    poolsInfo.textContent = `Показано ${pairsToDisplay.length} из ${pairsArray.length} пар (всего ${filteredPools.length} пулов)`;
  } else {
    loadMoreContainer.style.display = 'none';
  }
}

// Загрузка еще пулов
function loadMorePools() {
  displayedCount += POOLS_PER_PAGE;
  renderPools();
  
  // Плавная прокрутка к новым элементам
  const containerEl = document.getElementById('poolsContainer');
  const cards = containerEl.querySelectorAll('.pool-card');
  if (cards.length > 0) {
    const lastCard = cards[cards.length - 1];
    lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Инициализация списка launchpad
function initLaunchpadList() {
  const launchpadList = document.getElementById('launchpadList');
  launchpadList.innerHTML = '';
  
  LAUNCHPADS.forEach(launchpad => {
    const checkbox = document.createElement('div');
    checkbox.className = 'filter-checkbox';
    checkbox.innerHTML = `
      <label>
        <input type="checkbox" class="launchpad-checkbox" value="${launchpad}" />
        <span>${launchpad}</span>
      </label>
    `;
    launchpadList.appendChild(checkbox);
  });
  
  // Обновляем состояние чекбоксов
  updateLaunchpadCheckboxes();
}

function updateLaunchpadCheckboxes() {
  const checkboxes = document.querySelectorAll('.launchpad-checkbox');
  checkboxes.forEach(checkbox => {
    checkbox.checked = filters.launchpads.includes(checkbox.value);
  });
}

// Управление модальным окном фильтров
function openFilterModal() {
  const modal = document.getElementById('filterModal');
  modal.classList.add('show');
  
  // Заполняем форму текущими значениями фильтров
  document.getElementById('filterVerified').checked = filters.verified;
  const channelWidthInput = document.getElementById('filterChannelWidth');
  if (channelWidthInput) channelWidthInput.value = filters.channelWidth || '';
  document.getElementById('filterBinStepMin').value = filters.binStepMin || '';
  document.getElementById('filterBinStepMax').value = filters.binStepMax || '';
  document.getElementById('filterLiquidityMin').value = filters.liquidityMin || '';
  document.getElementById('filterLiquidityMax').value = filters.liquidityMax || '';
  document.getElementById('filterVolumePeriod').value = filters.volumePeriod;
  document.getElementById('filterVolumePeriodMin').value = filters.volumePeriodMin || '';
  document.getElementById('filterFeesPeriod').value = filters.feesPeriod;
  document.getElementById('filterFeesPeriodMin').value = filters.feesPeriodMin || '';
  document.getElementById('filterFees24hMin').value = filters.fees24hMin || '';
  document.getElementById('filterFees24hMax').value = filters.fees24hMax || '';
  document.getElementById('filterFeeTvlPeriod').value = filters.feeTvlPeriod;
  document.getElementById('filterFeeTvlPeriodMin').value = filters.feeTvlPeriodMin || '';
  document.getElementById('filterAprMin').value = filters.aprMin || '';
  document.getElementById('filterAprMax').value = filters.aprMax || '';
  document.getElementById('filterLfg').checked = filters.lfg;
  
  updateLaunchpadCheckboxes();
}

function closeFilterModal() {
  const modal = document.getElementById('filterModal');
  modal.classList.remove('show');
}

function resetFilters() {
  filters = {
    verified: false,
    channelWidth: null,
    binStepMin: null,
    binStepMax: null,
    liquidityMin: null,
    liquidityMax: null,
    volumePeriod: 'hour_24',
    volumePeriodMin: null,
    feesPeriod: 'hour_24',
    feesPeriodMin: null,
    fees24hMin: null,
    fees24hMax: null,
    feeTvlPeriod: 'hour_24',
    feeTvlPeriodMin: null,
    aprMin: null,
    aprMax: null,
    launchpads: [],
    lfg: false
  };
  
  // Очищаем форму
  document.getElementById('filterVerified').checked = false;
  const channelWidthInput = document.getElementById('filterChannelWidth');
  if (channelWidthInput) channelWidthInput.value = '';
  document.getElementById('filterBinStepMin').value = '';
  document.getElementById('filterBinStepMax').value = '';
  document.getElementById('filterLiquidityMin').value = '';
  document.getElementById('filterLiquidityMax').value = '';
  document.getElementById('filterVolumePeriod').value = 'hour_24';
  document.getElementById('filterVolumePeriodMin').value = '';
  document.getElementById('filterFeesPeriod').value = 'hour_24';
  document.getElementById('filterFeesPeriodMin').value = '';
  document.getElementById('filterFees24hMin').value = '';
  document.getElementById('filterFees24hMax').value = '';
  document.getElementById('filterFeeTvlPeriod').value = 'hour_24';
  document.getElementById('filterFeeTvlPeriodMin').value = '';
  document.getElementById('filterAprMin').value = '';
  document.getElementById('filterAprMax').value = '';
  document.getElementById('filterLfg').checked = false;
  
  updateLaunchpadCheckboxes();
  updateFilterButtonIndicator();
  applyFilters(); // Применяем сброс фильтров
}

function saveFilters() {
  // Сохраняем значения из формы
  filters.verified = document.getElementById('filterVerified').checked;
  
  const channelWidthInput = document.getElementById('filterChannelWidth');
  const channelWidth = channelWidthInput ? channelWidthInput.value.trim() : '';
  filters.channelWidth = channelWidth && channelWidth !== '' ? parseFloat(channelWidth) : null;
  
  const binStepMin = document.getElementById('filterBinStepMin').value.trim();
  filters.binStepMin = binStepMin && binStepMin !== '' ? parseFloat(binStepMin) : null;
  
  const binStepMax = document.getElementById('filterBinStepMax').value.trim();
  filters.binStepMax = binStepMax && binStepMax !== '' ? parseFloat(binStepMax) : null;
  
  const liquidityMin = document.getElementById('filterLiquidityMin').value.trim();
  filters.liquidityMin = liquidityMin && liquidityMin !== '' ? parseFloat(liquidityMin) : null;
  
  const liquidityMax = document.getElementById('filterLiquidityMax').value.trim();
  filters.liquidityMax = liquidityMax && liquidityMax !== '' ? parseFloat(liquidityMax) : null;
  
  filters.volumePeriod = document.getElementById('filterVolumePeriod').value;
  const volumePeriodMin = document.getElementById('filterVolumePeriodMin').value.trim();
  filters.volumePeriodMin = volumePeriodMin && volumePeriodMin !== '' ? parseFloat(volumePeriodMin) : null;
  
  filters.feesPeriod = document.getElementById('filterFeesPeriod').value;
  const feesPeriodMin = document.getElementById('filterFeesPeriodMin').value.trim();
  filters.feesPeriodMin = feesPeriodMin && feesPeriodMin !== '' ? parseFloat(feesPeriodMin) : null;
  
  const fees24hMin = document.getElementById('filterFees24hMin').value.trim();
  filters.fees24hMin = fees24hMin && fees24hMin !== '' ? parseFloat(fees24hMin) : null;
  
  const fees24hMax = document.getElementById('filterFees24hMax').value.trim();
  filters.fees24hMax = fees24hMax && fees24hMax !== '' ? parseFloat(fees24hMax) : null;
  
  filters.feeTvlPeriod = document.getElementById('filterFeeTvlPeriod').value;
  const feeTvlPeriodMin = document.getElementById('filterFeeTvlPeriodMin').value.trim();
  filters.feeTvlPeriodMin = feeTvlPeriodMin && feeTvlPeriodMin !== '' ? parseFloat(feeTvlPeriodMin) : null;
  
  const aprMin = document.getElementById('filterAprMin').value.trim();
  filters.aprMin = aprMin && aprMin !== '' ? parseFloat(aprMin) : null;
  
  const aprMax = document.getElementById('filterAprMax').value.trim();
  filters.aprMax = aprMax && aprMax !== '' ? parseFloat(aprMax) : null;
  
  // Сохраняем выбранные launchpad
  filters.launchpads = [];
  document.querySelectorAll('.launchpad-checkbox:checked').forEach(checkbox => {
    filters.launchpads.push(checkbox.value);
  });
  
  filters.lfg = document.getElementById('filterLfg').checked;
  
  console.log('💾 ========== СОХРАНЕНИЕ ФИЛЬТРОВ ==========');
  console.log('💾 Сохраненные фильтры:', JSON.stringify(filters, null, 2));
  console.log(`   - Verified: ${filters.verified}`);
  if (filters.channelWidth !== null && filters.channelWidth > 0) {
    const rangeInterval = 10;
    const channelWidthTotal = filters.channelWidth * 2;
    const totalBins = rangeInterval * 2;
    const minBinStepRequired = (channelWidthTotal / totalBins) * 100;
    console.log(`   - Ширина канала: ${filters.channelWidth}% (общая ${channelWidthTotal}%)`);
    console.log(`   - Требуется min bin_step: ${minBinStepRequired.toFixed(2)}`);
  } else {
    console.log(`   - Ширина канала: не указана`);
  }
  console.log(`   - Bin Step: ${filters.binStepMin || 'мин нет'} - ${filters.binStepMax || 'макс нет'}`);
  console.log(`   - Launchpads (${filters.launchpads.length}):`, filters.launchpads);
  console.log(`   - LFG: ${filters.lfg}`);
  console.log(`   - Liquidity: ${filters.liquidityMin || 'мин нет'} - ${filters.liquidityMax || 'макс нет'}`);
  console.log(`   - Volume (${filters.volumePeriod}): мин ${filters.volumePeriodMin || 'нет'}`);
  console.log(`   - Fees 24h: ${filters.fees24hMin || 'мин нет'} - ${filters.fees24hMax || 'макс нет'}`);
  console.log(`   - APR: ${filters.aprMin || 'мин нет'} - ${filters.aprMax || 'макс нет'}`);
  console.log('💾 ========================================');
  
  updateFilterButtonIndicator();
  closeFilterModal();
  applyFilters();
}

function selectAllLaunchpads() {
  const checkboxes = document.querySelectorAll('.launchpad-checkbox');
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  
  checkboxes.forEach(checkbox => {
    checkbox.checked = !allChecked;
  });
  
  const selectAllBtn = document.getElementById('selectAllLaunchpads');
  selectAllBtn.textContent = allChecked ? 'Select all' : 'Deselect all';
}

function updateFilterButtonIndicator() {
  const filterBtn = document.getElementById('filterBtn');
  const hasActiveFilters = 
    filters.verified ||
    filters.binStepMin !== null ||
    filters.binStepMax !== null ||
    filters.liquidityMin !== null ||
    filters.liquidityMax !== null ||
    filters.volumePeriodMin !== null ||
    filters.feesPeriodMin !== null ||
    filters.feeTvlPeriodMin !== null ||
    filters.aprMin !== null ||
    filters.aprMax !== null ||
    filters.launchpads.length > 0 ||
    filters.lfg;
  
  if (hasActiveFilters) {
    filterBtn.classList.add('filter-active');
    filterBtn.textContent = '🔍 Фильтр •';
  } else {
    filterBtn.classList.remove('filter-active');
    filterBtn.textContent = '🔍 Фильтр';
  }
}

// ========== TABS FUNCTIONALITY ==========
function initTabs() {
  const tabButtons = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.getAttribute('data-tab');

      // Remove active class from all tabs and contents
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));

      // Add active class to clicked tab and corresponding content
      button.classList.add('active');
      document.getElementById(`${targetTab}Tab`).classList.add('active');
      
      // Загружаем позиции при переключении на вкладку pools
      if (targetTab === 'pools') {
        loadPositions();
      }
    });
  });
}

// Инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
  // Initialize launchpad list
  initLaunchpadList();

  // Обработчики событий для фильтров (используем делегирование событий)
  const poolsContainer = document.getElementById('poolsContainer');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const closeFilterBtn = document.getElementById('closeFilterBtn');
  const resetFilterBtn = document.getElementById('resetFilterBtn');
  const saveFilterBtn = document.getElementById('saveFilterBtn');
  const selectAllLaunchpads = document.getElementById('selectAllLaunchpads');

  // Делегирование событий для динамически создаваемых элементов
  if (poolsContainer) {
    poolsContainer.addEventListener('input', (e) => {
      if (e.target.id === 'searchInput') {
        sessionStorage.setItem('poolsSearch', e.target.value);
        applyFilters();
      }
    });
    poolsContainer.addEventListener('change', (e) => {
      if (e.target.id === 'sortSelect') {
        sessionStorage.setItem('poolsSort', e.target.value);
        applyFilters();
      }
    });
    poolsContainer.addEventListener('click', (e) => {
      if (e.target.id === 'filterBtn' || e.target.closest('#filterBtn')) {
        openFilterModal();
      }
    });
  }
  
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMorePools);
  if (closeFilterBtn) closeFilterBtn.addEventListener('click', closeFilterModal);
  if (resetFilterBtn) resetFilterBtn.addEventListener('click', resetFilters);
  if (saveFilterBtn) saveFilterBtn.addEventListener('click', saveFilters);
  if (selectAllLaunchpads) selectAllLaunchpads.addEventListener('click', selectAllLaunchpads);

  // Закрытие модального окна при клике вне его
  const filterModal = document.getElementById('filterModal');
  if (filterModal) {
    filterModal.addEventListener('click', (e) => {
      if (e.target.id === 'filterModal') {
        closeFilterModal();
      }
    });
  }

  // Загрузка при старте
  loadPools(true, true);
  loadPositions(); // Загружаем позиции
  updateFilterButtonIndicator();

  // Запускаем автообновление каждые 3 минуты
  autoRefreshTimer = setInterval(autoRefreshPools, AUTO_REFRESH_INTERVAL);
  updateAutoRefreshInfo();

  // Initialize tabs
  initTabs();

  // Wallet event listeners
  const connectBtn = document.getElementById('connectPhantomBtn');
  const disconnectBtn = document.getElementById('disconnectWalletBtn');
  const copyBtn = document.getElementById('copyAddressBtn');

  if (connectBtn) connectBtn.addEventListener('click', connectPhantom);
  if (disconnectBtn) disconnectBtn.addEventListener('click', disconnectWallet);
  if (copyBtn) copyBtn.addEventListener('click', copyAddressToClipboard);
  
  // Refresh balance button
  const refreshBalanceBtn = document.getElementById('refreshBalanceBtn');
  if (refreshBalanceBtn) {
    refreshBalanceBtn.addEventListener('click', () => {
      if (walletPublicKey) {
        updateWalletBalance();
      }
    });
  }

  // Initialize forms
  initProxyForm();

  // Initialize Jupiter swap UI
  initJupiterSwap();

  // Load saved settings on page load
  loadWalletSettings();

  // Pool modal event listeners - ПРОСТОЕ РЕШЕНИЕ
  const closePoolModalBtn = document.getElementById('closePoolModalBtn');
  const poolModal = document.getElementById('poolModal');
  
  // Крестик просто возвращает на шаг назад
  if (closePoolModalBtn) {
    closePoolModalBtn.onclick = function() {
      window.history.back();
    };
  }
  
  // Закрытие по клику на фон
  if (poolModal) {
    poolModal.onclick = function(e) {
      if (e.target === poolModal) {
        closePoolModal();
      }
    };
    
    // Предотвращаем закрытие при клике на содержимое
    const poolModalContent = poolModal.querySelector('.pool-modal-content');
    if (poolModalContent) {
      poolModalContent.onclick = function(e) {
        e.stopPropagation();
      };
    }
  }
  
  // Обработчики для модального окна пары пулов
  const closePairPoolsModalBtn = document.getElementById('closePairPoolsModalBtn');
  const pairPoolsModal = document.getElementById('pairPoolsModal');
  if (closePairPoolsModalBtn) {
    closePairPoolsModalBtn.addEventListener('click', closePairPoolsModal);
  }
  if (pairPoolsModal) {
    pairPoolsModal.addEventListener('click', (e) => {
      if (e.target.id === 'pairPoolsModal') {
        closePairPoolsModal();
      }
    });
  }

  // Initialize admin panel
  initAdminPanel();

  // Check if Phantom is installed
  const provider = getPhantomProvider();
  if (!provider) {
    const errorEl = document.getElementById('walletError');
    if (errorEl) {
      errorEl.textContent = 'Phantom кошелек не установлен. Установите расширение Phantom для подключения кошелька.';
      errorEl.style.display = 'block';
    }
  }
});

// ========== PHANTOM WALLET FUNCTIONALITY ==========
let phantomWallet = null;
let walletPublicKey = null;
let walletBalance = null;

function getPhantomProvider() {
  if ('solana' in window) {
    const provider = window.solana;
    if (provider.isPhantom) {
      return provider;
    }
  }
  return null;
}

async function connectPhantom() {
  const errorEl = document.getElementById('walletError');
  errorEl.style.display = 'none';

  try {
    const provider = getPhantomProvider();
    if (!provider) {
      throw new Error('Phantom кошелек не найден. Установите расширение Phantom из Chrome Web Store.');
    }

    // Request connection
    const response = await provider.connect();
    walletPublicKey = response.publicKey.toString();
    phantomWallet = provider;

    // Update UI
    updateWalletUI();
    
    // Save wallet connection to server first
    await saveWalletSettings({ publicKey: walletPublicKey, connected: true });
    
    // Fetch balance (this will update UI when done)
    updateWalletBalance();
    
    // Загружаем позиции пользователя
    await loadUserPositions();
    // Загружаем позиции в основной секции
    await loadPositions();
    // Обновляем статистику
    await updateAdminStats();

    // Listen for disconnect
    provider.on('disconnect', handleWalletDisconnect);

    console.log('Phantom wallet connected:', walletPublicKey);
  } catch (error) {
    console.error('Error connecting Phantom:', error);
    errorEl.textContent = error.message || 'Ошибка подключения кошелька';
    errorEl.style.display = 'block';
  }
}

async function disconnectWallet() {
  try {
    if (phantomWallet) {
      await phantomWallet.disconnect();
    }
    handleWalletDisconnect();
    
    // Clear wallet settings on server
    await saveWalletSettings({ publicKey: null, connected: false });
    
    console.log('Wallet disconnected');
  } catch (error) {
    console.error('Error disconnecting wallet:', error);
  }
}

async function handleWalletDisconnect() {
  phantomWallet = null;
  walletPublicKey = null;
  walletBalance = null;
  updateWalletUI();
  // Очищаем список позиций
  const positionsList = document.getElementById('positionsList');
  if (positionsList) {
    positionsList.innerHTML = '<p style="color: rgba(255, 255, 255, 0.7);">Подключите кошелек для просмотра позиций</p>';
  }
  // Обновляем позиции в основной секции (покажем тестовые данные)
  loadPositions();
  // Сбрасываем статистику
  await updateAdminStats();
}

function updateWalletUI() {
  const statusEl = document.getElementById('walletStatus');
  const statusTextEl = document.getElementById('walletStatusText');
  const statusIndicator = statusEl.querySelector('.status-indicator');
  const walletInfoEl = document.getElementById('walletInfo');
  const addressEl = document.getElementById('walletAddress');
  const balanceEl = document.getElementById('walletBalance');
  const connectBtn = document.getElementById('connectPhantomBtn');
  const disconnectBtn = document.getElementById('disconnectWalletBtn');
  const refreshBalanceBtn = document.getElementById('refreshBalanceBtn');

  if (walletPublicKey) {
    statusIndicator.classList.remove('disconnected');
    statusIndicator.classList.add('connected');
    statusTextEl.textContent = 'Подключен';
    walletInfoEl.style.display = 'block';
    addressEl.textContent = walletPublicKey;
    
    // Обновляем только span с балансом, не весь элемент
    const balanceSpan = document.querySelector('#walletBalance');
    if (balanceSpan) {
      balanceSpan.textContent = walletBalance !== null ? `${walletBalance.toFixed(4)} SOL` : 'Загрузка...';
    }
    
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
    if (refreshBalanceBtn) refreshBalanceBtn.style.display = 'inline-block';
  } else {
    statusIndicator.classList.remove('connected');
    statusIndicator.classList.add('disconnected');
    statusTextEl.textContent = 'Не подключен';
    walletInfoEl.style.display = 'none';
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
    if (refreshBalanceBtn) refreshBalanceBtn.style.display = 'none';
  }
}

async function updateWalletBalance() {
  if (!walletPublicKey) return;

  // Показываем индикатор загрузки
  const balanceSpan = document.querySelector('#walletBalance');
  if (balanceSpan) {
    balanceSpan.textContent = 'Загрузка...';
  }
  
  // Скрываем ошибку при новой попытке
  const errorEl = document.getElementById('walletError');
  if (errorEl) {
    errorEl.style.display = 'none';
  }

  try {
    // Создаем AbortController для таймаута на клиенте
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 секунд таймаут

    // Fetch balance from server (server will use RPC)
    const response = await fetch(`/api/wallet/balance?address=${walletPublicKey}`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      walletBalance = data.balance || 0;
      updateWalletUI();
      
      // Скрываем ошибку если она была показана
      const errorEl = document.getElementById('walletError');
      if (errorEl) {
        errorEl.style.display = 'none';
      }
    } else {
      // Обработка ошибок от сервера
      const errorData = await response.json().catch(() => ({ error: 'Неизвестная ошибка' }));
      console.error('Error fetching balance:', errorData.error);
      
      // Показываем ошибку пользователю
      const errorEl = document.getElementById('walletError');
      if (errorEl) {
        errorEl.textContent = `Ошибка загрузки баланса: ${errorData.error}`;
        errorEl.style.display = 'block';
      }
      
      walletBalance = null;
      if (balanceSpan) {
        balanceSpan.textContent = 'Ошибка';
      }
    }
  } catch (error) {
    console.error('Error fetching balance:', error);
    
    // Обработка различных типов ошибок
    let errorMessage = 'Ошибка загрузки баланса';
    if (error.name === 'AbortError') {
      errorMessage = 'Таймаут: запрос занял слишком много времени. Попробуйте использовать другой RPC endpoint в настройках.';
    } else if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      errorMessage = 'Не удалось подключиться к серверу. Проверьте подключение к интернету.';
    } else {
      errorMessage = `Ошибка: ${error.message}`;
    }
    
    // Показываем ошибку пользователю
    const errorEl = document.getElementById('walletError');
    if (errorEl) {
      errorEl.textContent = errorMessage;
      errorEl.style.display = 'block';
    }
    
    walletBalance = null;
    if (balanceSpan) {
      balanceSpan.textContent = 'Ошибка';
    }
    
    // Обновляем UI чтобы показать ошибку
    updateWalletUI();
  }
}

function copyAddressToClipboard() {
  if (!walletPublicKey) return;
  
  navigator.clipboard.writeText(walletPublicKey).then(() => {
    const btn = document.getElementById('copyAddressBtn');
    const originalText = btn.textContent;
    btn.textContent = '✓ Скопировано';
    setTimeout(() => {
      btn.textContent = originalText;
    }, 2000);
  });
}

// ========== PROXY SETTINGS FUNCTIONALITY ==========
function initProxyForm() {
  const proxyEnabled = document.getElementById('proxyEnabled');
  const proxyInputs = document.querySelectorAll('#proxyForm input:not(#proxyEnabled), #proxyForm select');

  proxyEnabled.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    proxyInputs.forEach(input => {
      input.disabled = !enabled;
    });
    document.getElementById('testProxyBtn').disabled = !enabled;
    document.querySelector('#proxyForm .save-btn').disabled = !enabled;
  });

  document.getElementById('proxyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveProxySettings();
  });

  document.getElementById('testProxyBtn').addEventListener('click', async () => {
    await testProxy();
  });

  // Load saved settings
  loadProxySettings();
}

async function saveProxySettings() {
  const proxySettings = {
    enabled: document.getElementById('proxyEnabled').checked,
    type: document.getElementById('proxyType').value,
    host: document.getElementById('proxyHost').value,
    port: parseInt(document.getElementById('proxyPort').value),
    username: document.getElementById('proxyUsername').value || null,
    password: document.getElementById('proxyPassword').value || null,
  };

  try {
    const response = await fetch('/api/settings/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proxySettings),
    });

    if (!response.ok) throw new Error('Ошибка сохранения настроек прокси');

    showProxyStatus('Настройки прокси сохранены', 'success');
    console.log('Proxy settings saved:', proxySettings);
  } catch (error) {
    console.error('Error saving proxy settings:', error);
    showProxyStatus('Ошибка сохранения настроек: ' + error.message, 'error');
  }
}

async function loadProxySettings() {
  try {
    const response = await fetch('/api/settings/proxy');
    if (!response.ok) return;

    const settings = await response.json();
    if (settings) {
      document.getElementById('proxyEnabled').checked = settings.enabled || false;
      document.getElementById('proxyType').value = settings.type || 'http';
      document.getElementById('proxyHost').value = settings.host || '';
      document.getElementById('proxyPort').value = settings.port || '';
      document.getElementById('proxyUsername').value = settings.username || '';
      document.getElementById('proxyPassword').value = settings.password || '';

      // Trigger change event to enable/disable inputs
      document.getElementById('proxyEnabled').dispatchEvent(new Event('change'));
    }
  } catch (error) {
    console.error('Error loading proxy settings:', error);
  }
}

async function testProxy() {
  const statusEl = document.getElementById('proxyStatus');
  statusEl.style.display = 'block';
  statusEl.className = 'proxy-status info';
  statusEl.querySelector('.status-message').textContent = 'Тестирование прокси...';

  try {
    const response = await fetch('/api/settings/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: document.getElementById('proxyType').value,
        host: document.getElementById('proxyHost').value,
        port: parseInt(document.getElementById('proxyPort').value),
        username: document.getElementById('proxyUsername').value || null,
        password: document.getElementById('proxyPassword').value || null,
      }),
    });

    const result = await response.json();
    if (result.success) {
      showProxyStatus('Прокси работает корректно!', 'success');
    } else {
      showProxyStatus('Ошибка подключения к прокси: ' + (result.error || 'Неизвестная ошибка'), 'error');
    }
  } catch (error) {
    console.error('Error testing proxy:', error);
    showProxyStatus('Ошибка тестирования прокси: ' + error.message, 'error');
  }
}

function showProxyStatus(message, type) {
  const statusEl = document.getElementById('proxyStatus');
  statusEl.style.display = 'block';
  statusEl.className = `proxy-status ${type}`;
  statusEl.querySelector('.status-message').textContent = message;
}

// RPC settings removed: using fixed Helius RPC endpoint in backend

// Jupiter swap UI moved to swap.js

// ========== POOL MODAL FUNCTIONALITY ==========
let liquidityChart = null;
let tradingVolumeChart = null;
let feesChart = null;
let tvlChart = null;
let feeTvlChart = null;
let volumeComparisonChart = null;
let reservesChart = null;

async function openPoolModal(poolAddress) {
  // Сохраняем адрес пула для формы открытия позиции
  currentPoolAddress = poolAddress;
  
  const modal = document.getElementById('poolModal');
  const loadingEl = document.getElementById('poolModalLoading');
  const contentEl = document.getElementById('poolModalContent');
  const errorEl = document.getElementById('poolModalError');
  
  modal.classList.add('show');
  loadingEl.style.display = 'none';
  contentEl.style.display = 'block';
  errorEl.style.display = 'none';
  
  // Сбрасываем форму
  const form = document.getElementById('openPositionForm');
  if (form) {
    form.reset();
  }
  
  // Загружаем настройки пула (для внутренней логики)
  await loadPoolSettings(poolAddress);
  
  // Загружаем минимальные данные пула для расчета позиции
  try {
    const response = await fetch(`/api/pool/${poolAddress}`);
    if (!response.ok) {
      throw new Error('Ошибка загрузки данных пула');
    }
    
    const poolData = await response.json();
    
    // Сохраняем минимальные данные для создания позиции
    const price = parseFloat(poolData.price || poolData.current_price || poolData.price_usd || 0);
    currentPoolPrice = price;
    
    const binStep = poolData.bin_step || poolData.binStep || poolData.binStepValue || null;
    const activeBin = poolData.active_bin || poolData.activeBin || poolData.activeBinId || 
                      poolData.current_bin || poolData.currentBin || 
                      (poolData.activeBinData && poolData.activeBinData.binId) || null;
    
    currentPoolBinStep = binStep ? parseInt(binStep) : null;
    currentPoolActiveBin = activeBin !== null && activeBin !== undefined ? parseInt(activeBin) : null;
    
    // Получаем mint адреса токенов
    const tokenXMint = poolData.tokenXMint || poolData.token_x_mint || poolData.mint_x || poolData.base_mint;
    const tokenYMint = poolData.tokenYMint || poolData.token_y_mint || poolData.mint_y || poolData.quote_mint;
    
    // Получаем названия токенов
    let tokenXName = poolData.tokenX?.symbol || poolData.token_x?.symbol || 
                     poolData.tokenX?.name || poolData.token_x?.name ||
                     poolData.baseToken?.symbol || poolData.base_token?.symbol ||
                     'Token X';
    let tokenYName = poolData.tokenY?.symbol || poolData.token_y?.symbol ||
                     poolData.tokenY?.name || poolData.token_y?.name ||
                     poolData.quoteToken?.symbol || poolData.quote_token?.symbol ||
                     'Token Y';
    
    // Если не нашли, пытаемся извлечь из имени пула
    if (!tokenXName || !tokenYName) {
      const poolName = poolData.name || '';
      const nameMatch = poolName.match(/^([A-Z0-9]+)[\s\-/]+([A-Z0-9]+)/i);
      if (nameMatch && nameMatch.length >= 3) {
        if (!tokenXName) tokenXName = nameMatch[1].toUpperCase();
        if (!tokenYName) tokenYName = nameMatch[2].toUpperCase();
      }
    }
    
    // Сохраняем информацию о токенах
    currentPoolTokenX = {
      mint: tokenXMint,
      symbol: tokenXName,
      decimals: getTokenDecimalsForPool(tokenXMint)
    };
    currentPoolTokenY = {
      mint: tokenYMint,
      symbol: tokenYName,
      decimals: getTokenDecimalsForPool(tokenYMint)
    };
  } catch (error) {
    console.error('Error loading pool details:', error);
    loadingEl.style.display = 'none';
    errorEl.textContent = 'Ошибка загрузки данных: ' + error.message;
    errorEl.style.display = 'block';
  }
}

function closePoolModal() {
  const modal = document.getElementById('poolModal');
  if (modal) {
  modal.classList.remove('show');
  }
  
  // Очищаем информацию о токенах
  currentPoolAddress = null;
  currentPoolTokenX = null;
  currentPoolTokenY = null;
  currentPoolPrice = 0;
  currentPoolBinStep = null;
  currentPoolActiveBin = null;
  
  // Скрываем диапазон цен при закрытии модального окна
  const priceRangeEl = document.getElementById('positionPriceRange');
  if (priceRangeEl) {
    priceRangeEl.style.display = 'none';
  }
  
  // Уничтожаем графики при закрытии
  if (liquidityChart) {
    liquidityChart.destroy();
    liquidityChart = null;
  }
  if (tradingVolumeChart) {
    tradingVolumeChart.destroy();
    tradingVolumeChart = null;
  }
  if (feesChart) {
    feesChart.destroy();
    feesChart = null;
  }
  if (tvlChart) {
    tvlChart.destroy();
    tvlChart = null;
  }
  if (feeTvlChart) {
    feeTvlChart.destroy();
    feeTvlChart = null;
  }
  if (volumeComparisonChart) {
    volumeComparisonChart.destroy();
    volumeComparisonChart = null;
  }
  if (reservesChart) {
    reservesChart.destroy();
    reservesChart = null;
  }
}

// Открытие модального окна со списком пулов для пары токенов
// Новая функция для открытия модального окна с готовыми пулами
function openPairPoolsModalWithPools(pools, tokenXName, tokenYName) {
  const modal = document.getElementById('pairPoolsModal');
  const loadingEl = document.getElementById('pairPoolsModalLoading');
  const contentEl = document.getElementById('pairPoolsModalContent');
  const errorEl = document.getElementById('pairPoolsModalError');
  const containerEl = document.getElementById('pairPoolsContainer');
  
  modal.classList.add('show');
  loadingEl.style.display = 'none';
  contentEl.style.display = 'block';
  errorEl.style.display = 'none';
  containerEl.innerHTML = '';
  
  console.log('Открываем модальное окно с пулами:', { poolsCount: pools.length, tokenXName, tokenYName });
  
  // Обновляем заголовок
  document.getElementById('pairPoolsModalTitle').textContent = `Пулы для пары: ${tokenXName} / ${tokenYName}`;
  document.getElementById('pairPoolsCount').textContent = `Найдено пулов: ${pools.length}`;
  
  // Рендерим пулы
  renderPairPools(pools, containerEl);
}

async function openPairPoolsModal(tokenXMint, tokenYMint) {
  const modal = document.getElementById('pairPoolsModal');
  const loadingEl = document.getElementById('pairPoolsModalLoading');
  const contentEl = document.getElementById('pairPoolsModalContent');
  const errorEl = document.getElementById('pairPoolsModalError');
  const containerEl = document.getElementById('pairPoolsContainer');
  
  modal.classList.add('show');
  loadingEl.style.display = 'block';
  contentEl.style.display = 'none';
  errorEl.style.display = 'none';
  containerEl.innerHTML = '';
  
  try {
    // Загружаем пулы для пары токенов
    const response = await fetch(`/api/pools/by-pair?tokenXMint=${encodeURIComponent(tokenXMint)}&tokenYMint=${encodeURIComponent(tokenYMint)}`);
    if (!response.ok) {
      throw new Error('Ошибка загрузки пулов для пары');
    }
    
    const pools = await response.json();
    
    // Получаем названия токенов из первого пула или используем mint адреса
    let tokenXName = 'Token X';
    let tokenYName = 'Token Y';
    
    if (pools.length > 0) {
      const firstPool = pools[0];
      tokenXName = firstPool.tokenX?.symbol || firstPool.token_x?.symbol || 
                   firstPool.tokenX?.name || firstPool.token_x?.name || 
                   tokenXMint.substring(0, 8) + '...';
      tokenYName = firstPool.tokenY?.symbol || firstPool.token_y?.symbol || 
                   firstPool.tokenY?.name || firstPool.token_y?.name || 
                   tokenYMint.substring(0, 8) + '...';
    }
    
    // Используем новую функцию для отображения
    openPairPoolsModalWithPools(pools, tokenXName, tokenYName);
  } catch (error) {
    console.error('Error loading pools for pair:', error);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = 'Ошибка загрузки пулов: ' + error.message;
  }
}

// Продолжение функции openPairPoolsModalWithPools
function renderPairPools(pools, containerEl) {
    // Отображаем пулы
    if (pools.length === 0) {
      containerEl.innerHTML = '<div style="text-align: center; padding: 40px; color: rgba(255, 255, 255, 0.7);">Пулы для этой пары не найдены</div>';
    } else {
      // Сортируем пулы по bin step перед отображением
      const sortedPools = [...pools].sort((a, b) => {
        const binStepA = parseInt(a.bin_step || a.binStep || 0);
        const binStepB = parseInt(b.bin_step || b.binStep || 0);
        return binStepA - binStepB;
      });
      
      containerEl.innerHTML = sortedPools.map(pool => {
        const liquidity = parseFloat(pool.liquidity || 0);
        const volume24h = parseFloat(pool.trade_volume_24h || pool.volume?.hour_24 || 0);
        const fees24h = parseFloat(pool.fees_24h || pool.fees?.hour_24 || 0);
        const apr = parseFloat(pool.apr || 0);
        const apy = parseFloat(pool.apy || 0);
        const binStep = pool.bin_step || pool.binStep || '-';
        const baseFee = parseFloat(pool.base_fee_percentage || pool.baseFee || pool.base_fee_bps || 0);
        const maxFee = parseFloat(pool.max_fee_percentage || pool.maxFee || pool.max_fee_bps || 0);
        const protocolFee = parseFloat(pool.protocol_fee_percentage || pool.protocolFee || pool.protocol_fee_bps || 0);
        const dynamicFee = parseFloat(pool.dynamic_fee_percentage || pool.dynamicFee || 0);
        const price = parseFloat(pool.price || pool.current_price || pool.price_usd || 0);
        const feeTvlRatio = parseFloat(pool.fee_tvl_ratio?.hour_24 || pool.fee_tvl_ratio || 0) * 100;
        const volume7d = parseFloat(pool.volume?.hour_168 || pool.volume_7d || 0);
        const fees7d = parseFloat(pool.fees?.hour_168 || pool.fees_7d || 0);
        
        // Получаем резервы токенов
        const reserveX = parseFloat(pool.reserveX || pool.reserve_x || pool.tokenX?.reserve || pool.token_x?.reserve || 0);
        const reserveY = parseFloat(pool.reserveY || pool.reserve_y || pool.tokenY?.reserve || pool.token_y?.reserve || 0);
        
        // Дополнительная информация
        const activeBin = pool.active_bin || pool.activeBin || '-';
        const createdAt = pool.created_at ? new Date(pool.created_at).toLocaleDateString('ru-RU') : '-';
        
        return `
          <div class="bin-step-card" data-pool-address="${pool.address}">
            <div class="bin-step-header">
              <div class="bin-step-badge">
                <span class="bin-step-label">Bin Step</span>
                <span class="bin-step-number">${binStep}</span>
              </div>
              <div class="bin-step-tags">
                ${pool.is_verified ? '<span class="tag-verified">✓</span>' : ''}
                ${pool.tags?.includes('lfg') ? '<span class="tag-lfg">LFG</span>' : ''}
                ${pool.launchpad ? `<span class="tag-launchpad">${pool.launchpad}</span>` : ''}
            </div>
            </div>
            
            <div class="bin-step-address">${pool.address}</div>
            
            <div class="bin-step-metrics">
              <div class="metric-primary">
                <div class="metric-row">
                  <span class="metric-icon">💰</span>
                  <div class="metric-content">
                    <span class="metric-label">TVL</span>
                    <span class="metric-value">${formatCurrency(liquidity)}</span>
              </div>
                </div>
                ${(apr > 0 || apy > 0) ? `
                  <div class="metric-row highlight">
                    <span class="metric-icon">📈</span>
                    <div class="metric-content">
                      <span class="metric-label">APR / APY</span>
                      <span class="metric-value apr-value">${formatPercent(apr)} / ${formatPercent(apy)}</span>
              </div>
                </div>
              ` : ''}
            </div>
            
              <div class="metric-grid">
                <div class="metric-item">
                  <span class="metric-label">Vol 24h</span>
                  <span class="metric-value">${formatCurrency(volume24h)}</span>
              </div>
                <div class="metric-item">
                  <span class="metric-label">Fees 24h</span>
                  <span class="metric-value">${formatCurrency(fees24h)}</span>
                </div>
                ${price > 0 ? `
                  <div class="metric-item">
                    <span class="metric-label">Price</span>
                    <span class="metric-value">$${price.toFixed(6)}</span>
                </div>
              ` : ''}
                <div class="metric-item">
                  <span class="metric-label">Base Fee</span>
                  <span class="metric-value">${formatPercent(baseFee)}</span>
                </div>
                ${activeBin !== '-' ? `
                  <div class="metric-item">
                    <span class="metric-label">Active Bin</span>
                    <span class="metric-value">${activeBin}</span>
                </div>
              ` : ''}
                ${feeTvlRatio > 0 ? `
                  <div class="metric-item">
                    <span class="metric-label">Fee/TVL 24h</span>
                    <span class="metric-value">${formatPercent(feeTvlRatio)}</span>
                </div>
              ` : ''}
            </div>
                  </div>
          </div>
        `;
      }).join('');
      
      // Добавляем обработчики клика на карточки bin steps
      containerEl.querySelectorAll('.bin-step-card').forEach(card => {
        card.addEventListener('click', () => {
          const address = card.getAttribute('data-pool-address');
          if (address) {
            closePairPoolsModal();
            openPoolModal(address);
          }
        });
      });
  }
}

function closePairPoolsModal() {
  const modal = document.getElementById('pairPoolsModal');
  modal.classList.remove('show');
}

// ========== OPEN POSITION FUNCTIONALITY ==========
let currentPoolAddress = null;
let currentPoolTokenX = null; // { mint, symbol, decimals }
let currentPoolTokenY = null; // { mint, symbol, decimals }
let currentPoolPrice = 0; // Текущая цена пула
let currentPoolBinStep = null; // Bin step пула
let currentPoolActiveBin = null; // Active bin ID пула

/**
 * Обновить отображение диапазона цен позиции на основе rangeInterval
 */
function updatePositionPriceRange() {
  const priceRangeEl = document.getElementById('positionPriceRange');
  const rangeIntervalInput = document.getElementById('positionRangeInterval');
  
  if (!priceRangeEl || !rangeIntervalInput) {
    console.log('[PriceRange] Elements not found');
    return;
  }
  
  // Проверяем, есть ли все необходимые данные
  if (!currentPoolBinStep || currentPoolActiveBin === null || !currentPoolPrice || currentPoolPrice <= 0) {
    console.log('[PriceRange] Missing data:', {
      binStep: currentPoolBinStep,
      activeBin: currentPoolActiveBin,
      price: currentPoolPrice
    });
    priceRangeEl.style.display = 'none';
    return;
  }
  
  const rangeInterval = parseInt(rangeIntervalInput.value) || 10;
  
  if (rangeInterval < 1 || rangeInterval > 100) {
    priceRangeEl.style.display = 'none';
    return;
  }
  
  // Рассчитываем границы позиции на основе бинов
  // Формула: price = (1 + binStep/10000)^binId
  const base = 1 + currentPoolBinStep / 10000;
  
  // Для стратегии balance/imbalance: bins с обеих сторон
  const minBinId = currentPoolActiveBin - rangeInterval;
  const maxBinId = currentPoolActiveBin + rangeInterval;
  
  // Рассчитываем цены для границ (в формате Token X/Token Y)
  const lowerBoundPriceRaw = Math.pow(base, minBinId);
  const upperBoundPriceRaw = Math.pow(base, maxBinId + 1); // maxBinId включительный, поэтому +1 для верхней границы
  
  // Если текущая цена в долларах, а расчетные цены в формате Token X/Token Y,
  // нужно использовать процентное отклонение от текущей цены
  // Используем подход из priceMonitor.ts - процентное изменение на основе количества бинов
  const priceChangePerBin = currentPoolBinStep / 10000;
  const binsToLower = currentPoolActiveBin - minBinId;
  const binsToUpper = maxBinId - currentPoolActiveBin;
  
  // Рассчитываем множители для границ
  const lowerMultiplier = Math.pow(1 + priceChangePerBin, -binsToLower);
  const upperMultiplier = Math.pow(1 + priceChangePerBin, binsToUpper);
  
  // Применяем к текущей цене (в долларах)
  const lowerBoundPrice = currentPoolPrice * lowerMultiplier;
  const upperBoundPrice = currentPoolPrice * upperMultiplier;
  
  // Ширина диапазона в процентах
  const rangeWidthPercent = ((upperBoundPrice - lowerBoundPrice) / currentPoolPrice) * 100;
  
  // Обновляем отображение
  const lowerBoundEl = document.getElementById('positionLowerBound');
  const currentPriceEl = document.getElementById('positionCurrentPrice');
  const upperBoundEl = document.getElementById('positionUpperBound');
  const rangeWidthEl = document.getElementById('positionRangeWidth');
  
  if (lowerBoundEl) lowerBoundEl.textContent = '$' + lowerBoundPrice.toFixed(6);
  if (currentPriceEl) currentPriceEl.textContent = '$' + currentPoolPrice.toFixed(6);
  if (upperBoundEl) upperBoundEl.textContent = '$' + upperBoundPrice.toFixed(6);
  if (rangeWidthEl) rangeWidthEl.textContent = rangeWidthPercent.toFixed(2) + '%';
  
  // Показываем блок
  priceRangeEl.style.display = 'block';
  
  console.log('[PriceRange] Updated:', {
    rangeInterval,
    currentPrice: currentPoolPrice,
    lowerBound: lowerBoundPrice,
    upperBound: upperBoundPrice,
    rangeWidth: rangeWidthPercent + '%'
  });
}

// Конвертация из обычных единиц в минимальные единицы (с учетом decimals)
function convertToSmallestUnits(amount, decimals) {
  if (!decimals || decimals === 0) {
    // Если decimals неизвестен, предполагаем стандартные значения
    return Math.floor(Number(amount) * 1e9);
  }
  return Math.floor(Number(amount) * Math.pow(10, decimals));
}

// Получить decimals токена из tokenIndex или дефолтные значения
function getTokenDecimalsForPool(mintAddress) {
  if (!mintAddress) {
    console.warn('[getTokenDecimalsForPool] No mint address provided, using default 9');
    return 9; // По умолчанию 9 (как SOL)
  }
  
  // Пробуем получить из tokenIndex
  if (window.tokenIndexByAddress) {
    const token = window.tokenIndexByAddress.get(String(mintAddress));
    if (token && token.decimals !== undefined) {
      console.log(`[getTokenDecimalsForPool] Found decimals ${token.decimals} for ${mintAddress} from tokenIndex`);
      return token.decimals;
    }
  }
  
  // Дефолтные значения для популярных токенов
  const defaultDecimals = {
    'So11111111111111111111111111111111111111112': 9, // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
  };
  
  if (defaultDecimals[mintAddress]) {
    console.log(`[getTokenDecimalsForPool] Using default decimals ${defaultDecimals[mintAddress]} for ${mintAddress}`);
    return defaultDecimals[mintAddress];
  }
  
  console.warn(`[getTokenDecimalsForPool] Unknown mint address ${mintAddress}, using default 9`);
  return 9; // По умолчанию 9
}

// Функция для расчета автобаланса
async function calculateAutoBalance() {
  const totalAmountInput = document.getElementById('autoBalanceTotalAmount');
  const tokenXInput = document.getElementById('positionTokenXAmount');
  const tokenYInput = document.getElementById('positionTokenYAmount');
  
  if (!totalAmountInput || !tokenXInput || !tokenYInput) {
    showPositionStatus('Ошибка: элементы формы не найдены', 'error');
    return;
  }
  
  const totalAmount = parseFloat(totalAmountInput.value);
  console.log('[DEBUG] Auto balance input:', {
    totalAmountInputValue: totalAmountInput.value,
    totalAmountParsed: totalAmount,
  });
  
  if (!totalAmount || totalAmount <= 0) {
    showPositionStatus('Введите общую сумму больше 0', 'error');
    return;
  }
  
  if (!currentPoolAddress) {
    showPositionStatus('Ошибка: адрес пула не найден', 'error');
    return;
  }
  
  if (!currentPoolTokenX || !currentPoolTokenY) {
    showPositionStatus('Ошибка: информация о токенах пула не загружена', 'error');
    return;
  }
  
  try {
    showPositionStatus('Расчет автобаланса...', 'info');
    
    // Используем сохраненную цену пула или пытаемся получить её
    let currentPrice = currentPoolPrice;
    
    // Если цена не сохранена, пытаемся получить из списка пулов
    if (!currentPrice || currentPrice === 0) {
      try {
        const poolResponse = await fetch(`/api/pools`);
        if (poolResponse.ok) {
          const pools = await poolResponse.json();
          const pool = pools.find(p => p.address === currentPoolAddress);
          if (pool) {
            currentPrice = parseFloat(pool.price || pool.current_price || pool.price_usd || 0);
            currentPoolPrice = currentPrice; // Сохраняем для будущего использования
          }
        }
      } catch (error) {
        console.warn('Failed to get price from pools list:', error);
      }
    }
    
    // Если цена все еще неизвестна, используем упрощенный расчет
    if (!currentPrice || currentPrice === 0) {
      // Используем упрощенный расчет: делим общую сумму пополам
      // Предполагаем, что цена примерно равна 1 для упрощения
      const estimatedPrice = 1;
      const tokenXAmount = (totalAmount / 2) / estimatedPrice;
      const tokenYAmount = totalAmount / 2;
      
      tokenXInput.value = tokenXAmount.toFixed(9);
      tokenYInput.value = tokenYAmount.toFixed(6);
      
      showPositionStatus('Автобаланс рассчитан (использована приблизительная цена). Откройте модальное окно пула для получения точной цены.', 'info');
    } else {
      // Точный расчет с известной ценой
      // Для баланса 50/50: tokenXValue = tokenYValue = totalValue / 2
      // tokenXAmount * price = totalValue / 2
      // tokenXAmount = totalValue / (2 * price)
      // tokenYAmount = totalValue / 2
      
      const tokenXAmount = (totalAmount / 2) / currentPrice;
      const tokenYAmount = totalAmount / 2;
      
      // Учитываем decimals токенов для правильного отображения
      // ВАЖНО: используем decimals из currentPoolTokenX/Y, а не дефолтные значения
      const tokenXDecimals = currentPoolTokenX?.decimals || 9;
      const tokenYDecimals = currentPoolTokenY?.decimals || 6;
      
      const tokenXValue = tokenXAmount.toFixed(Math.min(tokenXDecimals, 9));
      const tokenYValue = tokenYAmount.toFixed(Math.min(tokenYDecimals, 6));
      
      tokenXInput.value = tokenXValue;
      tokenYInput.value = tokenYValue;
      
      // Отладочный вывод
      console.log('[DEBUG] Auto balance calculated:', {
        totalAmount,
        currentPrice,
        tokenXAmount,
        tokenYAmount,
        tokenXValue,
        tokenYValue,
        tokenXDecimals,
        tokenYDecimals,
      });
      
      showPositionStatus(`Автобаланс рассчитан успешно! (цена: $${currentPrice.toFixed(6)})`, 'success');
    }
    
    // Обновляем предварительный просмотр
    await previewPositionAmounts();
    
  } catch (error) {
    console.error('Error calculating auto balance:', error);
    showPositionStatus('Ошибка расчета автобаланса: ' + (error.message || 'Unknown'), 'error');
  }
}

// Функция для предварительного расчета реальных сумм
let previewAmountsTimeout = null;
async function previewPositionAmounts() {
  // Очищаем предыдущий таймаут
  if (previewAmountsTimeout) {
    clearTimeout(previewAmountsTimeout);
  }
  
  // Дебаунс: ждем 500ms после последнего изменения
  previewAmountsTimeout = setTimeout(async () => {
    const previewEl = document.getElementById('positionAmountPreview');
    if (!previewEl || !currentPoolAddress) return;
    
    const strategy = document.getElementById('positionStrategy')?.value;
    const rangeInterval = parseInt(document.getElementById('positionRangeInterval')?.value || '10');
    const tokenXAmountInput = document.getElementById('positionTokenXAmount')?.value;
    const tokenYAmountInput = document.getElementById('positionTokenYAmount')?.value;
    
    // Показываем предупреждение только для стратегии Balance
    if (strategy !== 'balance' || !tokenXAmountInput || !tokenYAmountInput || 
        parseFloat(tokenXAmountInput) <= 0 || parseFloat(tokenYAmountInput) <= 0) {
      previewEl.style.display = 'none';
      return;
    }
    
    try {
      // Конвертируем из обычных единиц в минимальные единицы
      if (!currentPoolTokenX || !currentPoolTokenY) {
        previewEl.style.display = 'none';
        return;
      }
      
      const tokenXAmount = convertToSmallestUnits(tokenXAmountInput, currentPoolTokenX.decimals).toString();
      const tokenYAmount = convertToSmallestUnits(tokenYAmountInput || '0', currentPoolTokenY.decimals).toString();
      
      // Запрашиваем предварительный расчет
      const res = await fetch('/api/meteora/preview-position-amounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          poolAddress: currentPoolAddress,
          strategy,
          rangeInterval,
          tokenXAmount,
          tokenYAmount,
        }),
      });
      
      if (!res.ok) {
        previewEl.style.display = 'none';
        return;
      }
      
      const preview = await res.json();
      
      // Конвертируем обратно в обычные единицы для отображения
      const convertFromSmallestUnits = (amount, decimals) => {
        return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals > 6 ? 6 : decimals);
      };
      
      const actualX = convertFromSmallestUnits(preview.actualTokenXAmount, preview.tokenXDecimals);
      const actualY = convertFromSmallestUnits(preview.actualTokenYAmount, preview.tokenYDecimals);
      
      // Обновляем значения в предупреждении
      document.getElementById('previewInputX').textContent = tokenXAmountInput + ' ' + (currentPoolTokenX.symbol || 'Token X');
      document.getElementById('previewActualX').textContent = actualX + ' ' + (currentPoolTokenX.symbol || 'Token X');
      document.getElementById('previewInputY').textContent = tokenYAmountInput + ' ' + (currentPoolTokenY.symbol || 'Token Y');
      document.getElementById('previewActualY').textContent = actualY + ' ' + (currentPoolTokenY.symbol || 'Token Y');
      
      // Показываем предупреждение
      previewEl.style.display = 'block';
    } catch (error) {
      console.error('Error previewing amounts:', error);
      previewEl.style.display = 'none';
    }
  }, 500);
}

function showPositionStatus(message, type) {
  const el = document.getElementById('positionStatus');
  if (!el) return;
  el.style.display = 'block';
  el.className = `rpc-status ${type}`;
  el.querySelector('.status-message').textContent = message;
}

function showPoolSettingsStatus(message, type) {
  const el = document.getElementById('poolSettingsStatus');
  if (!el) return;
  el.style.display = 'block';
  el.className = `rpc-status ${type}`;
  el.querySelector('.status-message').textContent = message;
}

// Загрузка настроек пула
async function loadPoolSettings(poolAddress) {
  if (!poolAddress) return;
  
  try {
    const response = await fetch(`/api/admin/pool-config/${poolAddress}`);
    if (!response.ok) {
      // Если настроек нет, используем значения по умолчанию
      return;
    }
    
    const config = await response.json();
    
    // Заполняем форму настройками пула
    // priceCorridorPercent больше не используется - границы рассчитываются по бинам
    document.getElementById('poolStopLossPercent').value = config.stopLossPercent || -2;
    document.getElementById('poolTakeProfitPercent').value = config.takeProfitPercent || 2;
    document.getElementById('poolFeeCheckPercent').value = config.feeCheckPercent || 50;
    
    if (config.mirrorSwap) {
      document.getElementById('poolMirrorSwapEnabled').checked = config.mirrorSwap.enabled || false;
      document.getElementById('poolHedgeAmountPercent').value = config.mirrorSwap.hedgeAmountPercent || 50;
      document.getElementById('poolSlippageBps').value = config.mirrorSwap.slippageBps || 100;
    }
    
    // averagePriceClose удалено - больше не используется
  } catch (error) {
    console.error('Error loading pool settings:', error);
  }
}

// Сохранение настроек пула
async function savePoolSettings(poolAddress) {
  if (!poolAddress) {
    showPoolSettingsStatus('Ошибка: адрес пула не найден', 'error');
    return;
  }
  
  const config = {
    stopLossPercent: parseFloat(document.getElementById('poolStopLossPercent').value),
    feeCheckPercent: parseFloat(document.getElementById('poolFeeCheckPercent').value),
    takeProfitPercent: parseFloat(document.getElementById('poolTakeProfitPercent').value),
    mirrorSwap: {
      enabled: document.getElementById('poolMirrorSwapEnabled').checked,
      hedgeAmountPercent: parseFloat(document.getElementById('poolHedgeAmountPercent').value),
      slippageBps: parseInt(document.getElementById('poolSlippageBps').value),
    },
  };
  
  try {
    showPoolSettingsStatus('Сохранение настроек...', 'info');
    
    const response = await fetch(`/api/admin/pool-config/${poolAddress}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save pool settings');
    }
    
    showPoolSettingsStatus('✅ Настройки пула сохранены!', 'success');
  } catch (error) {
    console.error('Error saving pool settings:', error);
    showPoolSettingsStatus('❌ Ошибка сохранения: ' + (error.message || 'Unknown'), 'error');
  }
}

// currentPoolAddress сохраняется в функции openPoolModal

// Обработчики для настроек пула и открытия позиции
document.addEventListener('DOMContentLoaded', () => {
  // Обработчик сохранения настроек пула
  const savePoolSettingsBtn = document.getElementById('savePoolSettingsBtn');
  if (savePoolSettingsBtn) {
    savePoolSettingsBtn.addEventListener('click', async () => {
      if (currentPoolAddress) {
        await savePoolSettings(currentPoolAddress);
      } else {
        showPoolSettingsStatus('Ошибка: адрес пула не найден', 'error');
      }
    });
  }
  
  // Добавляем обработчики для предварительного расчета сумм
  const positionStrategy = document.getElementById('positionStrategy');
  const positionRangeInterval = document.getElementById('positionRangeInterval');
  const positionTokenXAmount = document.getElementById('positionTokenXAmount');
  const positionTokenYAmount = document.getElementById('positionTokenYAmount');
  const autoBalanceBtn = document.getElementById('autoBalanceBtn');
  const autoBalanceTotalAmount = document.getElementById('autoBalanceTotalAmount');
  
  if (positionStrategy) {
    positionStrategy.addEventListener('change', previewPositionAmounts);
  }
  if (positionRangeInterval) {
    positionRangeInterval.addEventListener('input', () => {
      previewPositionAmounts();
      updatePositionPriceRange();
    });
  }
  if (positionTokenXAmount) {
    positionTokenXAmount.addEventListener('input', previewPositionAmounts);
  }
  if (positionTokenYAmount) {
    positionTokenYAmount.addEventListener('input', previewPositionAmounts);
  }
  
  // Обработчик кнопки автобаланса
  if (autoBalanceBtn) {
    autoBalanceBtn.addEventListener('click', async () => {
      await calculateAutoBalance();
    });
  }
  
  // Обработчик Enter в поле общей суммы
  if (autoBalanceTotalAmount) {
    autoBalanceTotalAmount.addEventListener('keypress', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await calculateAutoBalance();
      }
    });
  }
  
  // Обработчик формы открытия позиции
  const openPositionForm = document.getElementById('openPositionForm');
  if (openPositionForm) {
    openPositionForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      if (!walletPublicKey) {
        showPositionStatus('Подключите Phantom кошелек', 'error');
        return;
      }
      
      if (!currentPoolAddress) {
        showPositionStatus('Ошибка: адрес пула не найден', 'error');
        return;
      }
      
      // Получаем общую сумму из инпута
      const totalAmountInput = document.getElementById('positionTotalAmount')?.value;
      
      if (!totalAmountInput || parseFloat(totalAmountInput) <= 0) {
        showPositionStatus('Введите общую сумму позиции в USD', 'error');
        return;
      }
      
      const totalAmountUSD = parseFloat(totalAmountInput);
      
      // Проверяем наличие данных о пуле
      if (!currentPoolTokenX || !currentPoolTokenY || !currentPoolPrice || currentPoolPrice <= 0) {
        showPositionStatus('Ошибка: информация о пуле не загружена', 'error');
        return;
      }
      
      // Рассчитываем баланс 50/50
      // Для баланса 50/50: половина суммы в USD идет на Token X, половина на Token Y
      const tokenXAmountUSD = totalAmountUSD / 2;
      const tokenYAmountUSD = totalAmountUSD / 2;
      
      // Конвертируем USD в количество токенов
      // Token X: количество = USD / цена
      const tokenXAmountInput = (tokenXAmountUSD / currentPoolPrice).toFixed(9);
      // Token Y: количество = USD (предполагаем, что Y - это stablecoin или 1:1 с USD)
      const tokenYAmountInput = tokenYAmountUSD.toFixed(9);
      
      // Используем стратегию balance по умолчанию
      const strategy = 'balance';
      // Используем диапазон 10 по умолчанию
      const rangeInterval = 10;
      
      // Конвертируем из обычных единиц в минимальные единицы
      const tokenXAmount = convertToSmallestUnits(tokenXAmountInput, currentPoolTokenX.decimals).toString();
      const tokenYAmount = convertToSmallestUnits(tokenYAmountInput, currentPoolTokenY.decimals).toString();
      
      // Отладочный вывод после конвертации
      console.log('[DEBUG] After conversion to smallest units:', {
        tokenXAmountInput,
        tokenYAmountInput,
        tokenXDecimals: currentPoolTokenX.decimals,
        tokenYDecimals: currentPoolTokenY.decimals,
        tokenXAmount,
        tokenYAmount,
        tokenXAmountHuman: parseFloat(tokenXAmount) / Math.pow(10, currentPoolTokenX.decimals),
        tokenYAmountHuman: parseFloat(tokenYAmount) / Math.pow(10, currentPoolTokenY.decimals),
      });
      
      try {
        showPositionStatus('Генерация транзакции...', 'info');
        
        // Автоматически сохраняем настройки пула перед открытием позиции
        await savePoolSettings(currentPoolAddress);
        
        // 1) Запрашиваем у сервера транзакцию открытия позиции
        // Получаем настройки авто-клейма
        const autoClaimEnabled = document.getElementById('autoClaimEnabled')?.checked || false;
        const autoClaimThreshold = parseFloat(document.getElementById('autoClaimThreshold')?.value || '0');
        const autoClaim = autoClaimEnabled && autoClaimThreshold > 0 ? {
          enabled: true,
          thresholdUSD: autoClaimThreshold,
        } : undefined;

        const res = await fetch('/api/meteora/open-position-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            poolAddress: currentPoolAddress,
            userPublicKey: walletPublicKey,
            strategy,
            rangeInterval,
            tokenXAmount,
            tokenYAmount,
            autoClaim,
          }),
        });
        
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Create position tx failed');
        }
        
        const { transaction: txBase64, positionPublicKey, positionSecretKey } = data;
        
        // 2) Десериализуем транзакцию
        const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
        const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
        
        // 3) Подписываем position keypair
        const positionKeypair = solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(positionSecretKey));
        tx.sign([positionKeypair]);
        
        // 4) Подписываем пользовательским кошельком через Phantom
        const provider = getPhantomProvider();
        if (!provider) {
          throw new Error('Phantom не найден');
        }
        
        showPositionStatus('Подписание транзакции...', 'info');
        const signed = await provider.signTransaction(tx);
        
        // 5) Отправляем через наш сервер с ожиданием подтверждения
        const signedBase64 = btoa(String.fromCharCode(...signed.serialize()));
        showPositionStatus('Отправка транзакции...', 'info');
        
        // Создаем AbortController для таймаута
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 90000); // 90 секунд таймаут
        
        try {
          const sendRes = await fetch('/api/tx/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              signedTxBase64: signedBase64,
              waitForConfirmation: true,
            }),
            signal: controller.signal,
          });
          
          clearTimeout(timeoutId);
          
          const sendData = await sendRes.json();
          if (!sendRes.ok) {
            // Если blockhash устарел, предлагаем пересоздать транзакцию
            if (sendData.code === 'BLOCKHASH_EXPIRED' || sendData.expired || sendData.timeout) {
              throw new Error(`${sendData.error || 'Транзакция истекла'}. ${sendData.hint || 'Попробуйте создать транзакцию заново.'}`);
            }
            throw new Error(sendData.error || 'Send failed');
          }
          
          const sig = sendData.signature;
          
          // Проверяем, подтвердилась ли транзакция
          if (sendData.confirmed === false) {
            showPositionStatus(`⚠️ Транзакция отправлена, но не подтверждена. Signature: ${sig} | Проверьте в Solscan`, 'error');
            return;
          }
          
          if (sendData.err) {
            throw new Error(`Транзакция отклонена: ${JSON.stringify(sendData.err)}`);
          }
          
          // Проверяем, что позиция действительно создана (пробуем несколько раз с задержкой)
          showPositionStatus('Проверка создания позиции...', 'info');
          let positionExists = false;
          for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Даем время на обработку
            try {
              const checkRes = await fetch(`/api/positions/${positionPublicKey}/verify?poolAddress=${encodeURIComponent(currentPoolAddress)}&userAddress=${encodeURIComponent(walletPublicKey)}`);
              if (checkRes.ok) {
                const checkData = await checkRes.json();
                if (checkData.exists) {
                  positionExists = true;
                  break;
                }
              }
            } catch (e) {
              console.warn('Position verification attempt failed:', e);
            }
          }
          
          if (!positionExists) {
            showPositionStatus(`⚠️ Транзакция подтверждена, но позиция еще не найдена. Signature: ${sig} | Position: ${positionPublicKey} | Проверьте позже в Solscan`, 'error');
            // НЕ сохраняем позицию, если она не найдена на блокчейне
            return;
          }
          
          showPositionStatus(`✅ Позиция открыта и подтверждена! Signature: ${sig} | Position: ${positionPublicKey}`, 'success');
          
          // Сохраняем позицию в базу данных ТОЛЬКО после подтверждения существования
          try {
          // Используем уже загруженную информацию о токенах
          let tokenXMint = '';
          let tokenYMint = '';
          
          if (currentPoolTokenX && currentPoolTokenX.mint) {
            tokenXMint = currentPoolTokenX.mint;
          }
          if (currentPoolTokenY && currentPoolTokenY.mint) {
            tokenYMint = currentPoolTokenY.mint;
          }
          
          // Отладочный вывод перед сохранением
          console.log('[DEBUG] Saving position with amounts:', {
            tokenXAmountInput: tokenXAmountInput,
            tokenYAmountInput: tokenYAmountInput,
            tokenXAmount: tokenXAmount,
            tokenYAmount: tokenYAmount,
            tokenXDecimals: currentPoolTokenX?.decimals,
            tokenYDecimals: currentPoolTokenY?.decimals,
          });
          
          // Сохраняем позицию
          const saveRes = await fetch('/api/positions/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              positionAddress: positionPublicKey,
              poolAddress: currentPoolAddress,
              userAddress: walletPublicKey,
              autoClaim: autoClaim,
              strategy,
              rangeInterval,
              tokenXAmount,
              tokenYAmount,
              tokenXMint,
              tokenYMint,
            }),
          });
          
          if (saveRes.ok) {
            console.log('Position saved successfully');
            // Обновляем список позиций
            await loadUserPositions();
            // Обновляем статистику
            await updateAdminStats();
          } else {
            console.warn('Failed to save position:', await saveRes.text());
          }
          } catch (saveError) {
            console.error('Error saving position:', saveError);
            // Не прерываем процесс, позиция уже открыта
          }
          
          // Очищаем форму
          openPositionForm.reset();
        } catch (sendError) {
          console.error('Error sending transaction:', sendError);
          showPositionStatus('Ошибка отправки транзакции: ' + (sendError.message || 'Unknown'), 'error');
        }
      } catch (err) {
        console.error('Open position error:', err);
        showPositionStatus('Ошибка открытия позиции: ' + (err.message || 'Unknown'), 'error');
      }
    });
  }
});

function createLiquidityChart(bins, tokenXName, tokenYName, currentPrice) {
  const ctx = document.getElementById('liquidityChart');
  if (!ctx) return;
  
  // Уничтожаем предыдущий график, если есть
  if (liquidityChart) {
    liquidityChart.destroy();
  }
  
  // Обрабатываем данные bins
  const processedData = processBinsData(bins, currentPrice);
  
  liquidityChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: processedData.labels,
      datasets: [
        {
          label: tokenXName,
          data: processedData.tokenXData,
          backgroundColor: 'rgba(0, 217, 255, 0.7)',
          borderColor: '#00D9FF',
          borderWidth: 1,
        },
        {
          label: tokenYName,
          data: processedData.tokenYData,
          backgroundColor: 'rgba(139, 92, 246, 0.7)',
          borderColor: '#8B5CF6',
          borderWidth: 1,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false, // Используем кастомную легенду
        },
        tooltip: {
          callbacks: {
            title: function(context) {
              return `Price: ${context[0].label}`;
            },
            label: function(context) {
              const datasetLabel = context.dataset.label;
              const value = context.parsed.y;
              if (value > 0) {
                return `${datasetLabel}: ${formatNumber(value)}`;
              }
              return '';
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          title: {
            display: true,
            text: 'Price'
          }
        },
        y: {
          stacked: true,
          title: {
            display: true,
            text: 'Liquidity'
          },
          beginAtZero: true
        }
      }
    }
  });
}

function createLiquidityChartFromPoolData(poolData, tokenXName, tokenYName, currentPrice) {
  // Если нет данных о bins, создаем упрощенный график
  const ctx = document.getElementById('liquidityChart');
  if (!ctx) return;
  
  if (liquidityChart) {
    liquidityChart.destroy();
  }
  
  // Создаем примерные данные на основе текущей цены
  const priceRange = currentPrice * 0.1; // 10% диапазон
  const minPrice = currentPrice - priceRange;
  const maxPrice = currentPrice + priceRange;
  const steps = 20;
  const stepSize = (maxPrice - minPrice) / steps;
  
  const labels = [];
  const tokenXData = [];
  const tokenYData = [];
  
  for (let i = 0; i < steps; i++) {
    const price = minPrice + (stepSize * i);
    labels.push(price.toFixed(2));
    
    // Создаем примерное распределение (больше ликвидности около текущей цены)
    const distanceFromCurrent = Math.abs(price - currentPrice) / currentPrice;
    const liquidityFactor = Math.max(0, 1 - distanceFromCurrent * 2);
    
    if (price < currentPrice) {
      tokenXData.push(liquidityFactor * 100);
      tokenYData.push(0);
    } else {
      tokenXData.push(0);
      tokenYData.push(liquidityFactor * 100);
    }
  }
  
  liquidityChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: tokenXName,
          data: tokenXData,
          backgroundColor: 'rgba(0, 217, 255, 0.7)',
          borderColor: '#00D9FF',
          borderWidth: 1,
        },
        {
          label: tokenYName,
          data: tokenYData,
          backgroundColor: 'rgba(139, 92, 246, 0.7)',
          borderColor: '#8B5CF6',
          borderWidth: 1,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            title: function(context) {
              return `Price: ${context[0].label}`;
            },
            label: function(context) {
              const datasetLabel = context.dataset.label;
              const value = context.parsed.y;
              if (value > 0) {
                return `${datasetLabel}: ${formatNumber(value)}`;
              }
              return '';
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          title: {
            display: true,
            text: 'Price'
          }
        },
        y: {
          stacked: true,
          title: {
            display: true,
            text: 'Liquidity'
          },
          beginAtZero: true
        }
      }
    }
  });
}

function processBinsData(bins, currentPrice) {
  // Обрабатываем данные bins для отображения на графике
  if (!Array.isArray(bins) || bins.length === 0) {
    return { labels: [], tokenXData: [], tokenYData: [] };
  }
  
  // Сортируем bins по цене
  const sortedBins = bins
    .filter(bin => bin.liquidityX > 0 || bin.liquidityY > 0)
    .sort((a, b) => parseFloat(a.price || 0) - parseFloat(b.price || 0));
  
  const labels = [];
  const tokenXData = [];
  const tokenYData = [];
  
  sortedBins.forEach(bin => {
    const price = parseFloat(bin.price || 0);
    const liquidityX = parseFloat(bin.liquidityX || bin.liquidity_x || 0);
    const liquidityY = parseFloat(bin.liquidityY || bin.liquidity_y || 0);
    
    labels.push(price.toFixed(2));
    tokenXData.push(liquidityX);
    tokenYData.push(liquidityY);
  });
  
  return { labels, tokenXData, tokenYData };
}

function createTradingVolumeChart(poolData) {
  const ctx = document.getElementById('tradingVolumeChart');
  if (!ctx) return;
  
  // Уничтожаем предыдущий график, если есть
  if (tradingVolumeChart) {
    tradingVolumeChart.destroy();
  }
  
  // Получаем данные о торговом объеме из API
  const volume24h = parseFloat(poolData.trade_volume_24h || poolData.volume_24h || poolData.volume?.hour_24 || 0);
  
  // Отображаем текущее значение
  document.getElementById('tradingVolumeValue').textContent = formatCurrency(volume24h);
  
  const labels = [];
  const volumeData = [];
  
  // Логируем структуру данных для отладки
  console.log('Volume data from API:', {
    volumeHistory: poolData.volumeHistory,
    volume_history: poolData.volume_history,
    volume: poolData.volume,
    daily_volume: poolData.daily_volume,
    volume_by_day: poolData.volume_by_day,
    trade_volume_24h: poolData.trade_volume_24h
  });
  
  // Используем только реальные данные из API Meteora
  let foundData = false;
  
  // Вариант 1: volumeHistory из API (массив)
  if (poolData.volumeHistory && Array.isArray(poolData.volumeHistory) && poolData.volumeHistory.length > 0) {
    console.log('Using volumeHistory from API');
    poolData.volumeHistory.forEach(item => {
      const date = new Date(item.date || item.timestamp * 1000 || item.time * 1000 || item.day || item.timestamp);
      if (!isNaN(date.getTime())) {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames[date.getMonth()];
        const day = date.getDate().toString().padStart(2, '0');
        labels.push(`${month} ${day}`);
        const vol = parseFloat(item.volume || item.value || item.amount || item.total_volume || item.volume_usd || 0);
        volumeData.push(vol);
      }
    });
    foundData = labels.length > 0;
  }
  
  // Вариант 2: volume_history (альтернативное поле)
  if (!foundData && poolData.volume_history && Array.isArray(poolData.volume_history) && poolData.volume_history.length > 0) {
    console.log('Using volume_history from API');
    poolData.volume_history.forEach(item => {
      const date = new Date(item.date || item.timestamp * 1000 || item.time * 1000 || item.day || item.timestamp);
      if (!isNaN(date.getTime())) {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = monthNames[date.getMonth()];
        const day = date.getDate().toString().padStart(2, '0');
        labels.push(`${month} ${day}`);
        const vol = parseFloat(item.volume || item.value || item.amount || item.total_volume || item.volume_usd || 0);
        volumeData.push(vol);
      }
    });
    foundData = labels.length > 0;
  }
  
  // Вариант 3: volume как объект с периодами времени (min_30, hour_1 и т.д.) из API
  if (!foundData && poolData.volume && typeof poolData.volume === 'object' && !Array.isArray(poolData.volume)) {
    console.log('Volume object found, checking structure...');
    console.log('Volume object keys:', Object.keys(poolData.volume));
    console.log('Volume object full data:', JSON.stringify(poolData.volume, null, 2));
    
    const volumeKeys = Object.keys(poolData.volume);
    
    // Проверяем, являются ли ключи периодами времени (min_30, hour_1 и т.д.)
    const isTimePeriods = volumeKeys.some(key => 
      /^(min_|hour_|day_|week_|month_)/.test(key)
    );
    
    if (isTimePeriods) {
      console.log('Using volume data with time periods from API');
      
      // Порядок периодов для сортировки
      const periodOrder = {
        'min_30': 1,
        'hour_1': 2,
        'hour_2': 3,
        'hour_4': 4,
        'hour_12': 5,
        'hour_24': 6,
        'day_1': 7,
        'day_7': 8,
        'week_1': 9,
        'month_1': 10
      };
      
      // Функция для форматирования названия периода
      const formatPeriodLabel = (key) => {
        if (key.startsWith('min_')) {
          const mins = key.replace('min_', '');
          return `${mins}m`;
        } else if (key.startsWith('hour_')) {
          const hours = key.replace('hour_', '');
          return `${hours}h`;
        } else if (key.startsWith('day_')) {
          const days = key.replace('day_', '');
          return `${days}d`;
        } else if (key.startsWith('week_')) {
          const weeks = key.replace('week_', '');
          return `${weeks}w`;
        } else if (key.startsWith('month_')) {
          const months = key.replace('month_', '');
          return `${months}mo`;
        }
        return key;
      };
      
      // Сортируем ключи по порядку периодов
      const sortedKeys = volumeKeys
        .filter(key => /^(min_|hour_|day_|week_|month_)/.test(key))
        .sort((a, b) => {
          const orderA = periodOrder[a] || 999;
          const orderB = periodOrder[b] || 999;
          return orderA - orderB;
        });
      
      sortedKeys.forEach(key => {
        const rawValue = poolData.volume[key];
        const vol = parseFloat(rawValue || 0);
        console.log(`  Volume [${key}]: raw=${rawValue}, parsed=${vol}`);
          labels.push(formatPeriodLabel(key));
          volumeData.push(vol);
      });
      
      foundData = labels.length > 0 && volumeData.some(v => v > 0);
      console.log('Added volume data by periods:', { labels, volumeData, hasNonZero: foundData });
    } else {
      // Пытаемся найти ключи, которые выглядят как даты
      const dateKeys = volumeKeys.filter(key => {
        return /^\d{4}-\d{2}-\d{2}/.test(key) || /^\d{10,13}$/.test(key);
      });
      
      console.log('Date-like keys found:', dateKeys);
      
      if (dateKeys.length > 0) {
        dateKeys.forEach(key => {
          let date;
          if (/^\d{4}-\d{2}-\d{2}/.test(key)) {
            date = new Date(key);
          } else {
            date = new Date(parseInt(key) * (key.length === 10 ? 1000 : 1));
          }
          if (!isNaN(date.getTime())) {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const month = monthNames[date.getMonth()];
            const day = date.getDate().toString().padStart(2, '0');
            labels.push(`${month} ${day}`);
            const vol = parseFloat(poolData.volume[key] || 0);
            volumeData.push(vol);
            console.log(`Added data point: ${month} ${day} = ${vol}`);
          }
        });
        foundData = labels.length > 0;
      } else {
        // Если значения - это объекты с датами
        const firstKey = volumeKeys[0];
        const firstValue = poolData.volume[firstKey];
        
        if (typeof firstValue === 'object' && firstValue !== null) {
          console.log('Values are objects, trying to extract dates from them');
          volumeKeys.forEach(key => {
            const value = poolData.volume[key];
            if (value && typeof value === 'object') {
              const dateStr = value.date || value.timestamp || value.day || value.time || key;
              const date = new Date(dateStr || (typeof dateStr === 'number' ? dateStr * 1000 : dateStr));
              if (!isNaN(date.getTime())) {
                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                const month = monthNames[date.getMonth()];
                const day = date.getDate().toString().padStart(2, '0');
                labels.push(`${month} ${day}`);
                const vol = parseFloat(value.volume || value.value || value.amount || value.total_volume || value.volume_usd || 0);
                volumeData.push(vol);
              }
            }
          });
          foundData = labels.length > 0;
        }
      }
    }
  }
  
  // Вариант 4: daily_volume или volume_by_day из API
  if (!foundData && (poolData.daily_volume || poolData.volume_by_day)) {
    console.log('Using daily_volume or volume_by_day from API');
    const dailyData = poolData.daily_volume || poolData.volume_by_day;
    if (Array.isArray(dailyData)) {
      dailyData.forEach(item => {
        const date = new Date(item.date || item.day || item.timestamp * 1000 || item.timestamp);
        if (!isNaN(date.getTime())) {
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const month = monthNames[date.getMonth()];
          const day = date.getDate().toString().padStart(2, '0');
          labels.push(`${month} ${day}`);
          const vol = parseFloat(item.volume || item.value || item.volume_usd || 0);
          volumeData.push(vol);
        }
      });
      foundData = labels.length > 0;
    }
  }
  
  // Вариант 5: Используем данные из volumeHistory, если они пришли с сервера
  if (!foundData && poolData.volumeHistory && (Array.isArray(poolData.volumeHistory) || typeof poolData.volumeHistory === 'object')) {
    console.log('Using volumeHistory from server response');
    let historyData = poolData.volumeHistory;
    
    // Если это объект, пробуем найти массив внутри
    if (typeof historyData === 'object' && !Array.isArray(historyData)) {
      // Пробуем найти массив данных внутри объекта
      if (historyData.data && Array.isArray(historyData.data)) {
        historyData = historyData.data;
      } else if (historyData.history && Array.isArray(historyData.history)) {
        historyData = historyData.history;
      } else if (historyData.volumes && Array.isArray(historyData.volumes)) {
        historyData = historyData.volumes;
      } else {
        // Пробуем использовать объект как массив пар ключ-значение
        historyData = Object.entries(historyData).map(([key, value]) => ({ date: key, volume: value }));
      }
    }
    
    if (Array.isArray(historyData) && historyData.length > 0) {
      historyData.forEach(item => {
        const date = new Date(item.date || item.timestamp * 1000 || item.time * 1000 || item.day || item.timestamp || item[0]);
        if (!isNaN(date.getTime())) {
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const month = monthNames[date.getMonth()];
          const day = date.getDate().toString().padStart(2, '0');
          labels.push(`${month} ${day}`);
          const vol = parseFloat(item.volume || item.value || item.amount || item.total_volume || item.volume_usd || item[1] || 0);
          volumeData.push(vol);
        }
      });
      foundData = labels.length > 0;
    }
  }
  
  // Если нет реальных данных из API, не показываем график
  if (!foundData || labels.length === 0 || volumeData.length === 0) {
    console.warn('No volume history data available from Meteora API');
    console.warn('Available volume fields:', Object.keys(poolData).filter(key => 
      key.toLowerCase().includes('volume') || key.toLowerCase().includes('trade')
    ));
    // Скрываем график, если нет данных
    const chartContainer = document.querySelector('.trading-volume-chart-container');
    if (chartContainer) {
      chartContainer.style.display = 'none';
    }
    // Скрываем всю секцию, если нет данных
    const volumeSection = document.querySelector('.trading-volume-section');
    if (volumeSection) {
      volumeSection.style.display = 'none';
    }
    return;
  }
  
  // Показываем контейнер графика
  const chartContainer = document.querySelector('.trading-volume-chart-container');
  if (chartContainer) {
    chartContainer.style.display = 'block';
  }
  
  // Показываем секцию
  const volumeSection = document.querySelector('.trading-volume-section');
  if (volumeSection) {
    volumeSection.style.display = 'block';
  }
  
  console.log('Building chart with data:', { labels, volumeData, count: labels.length });
  
  // Если это периоды времени, данные уже отсортированы, сортировка не нужна
  // Если это даты, сортируем по дате
  const isPeriods = labels.some(label => /^\d+[mhdwmo]$/.test(label));
  
  if (!isPeriods) {
    // Сортируем данные по дате только если это не периоды
    const combined = labels.map((label, index) => ({ label, volume: volumeData[index] }));
    combined.sort((a, b) => {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const aParts = a.label.split(' ');
      const bParts = b.label.split(' ');
      const aMonth = monthNames.indexOf(aParts[0]);
      const bMonth = monthNames.indexOf(bParts[0]);
      const aDay = parseInt(aParts[1]);
      const bDay = parseInt(bParts[1]);
      
      if (aMonth !== bMonth) return aMonth - bMonth;
      return aDay - bDay;
    });
    
    labels.length = 0;
    volumeData.length = 0;
    combined.forEach(item => {
      labels.push(item.label);
      volumeData.push(item.volume);
    });
  }
  
  tradingVolumeChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Trading Volume',
        data: volumeData,
        borderColor: '#FF6B6B',
        backgroundColor: 'rgba(255, 107, 107, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointBackgroundColor: '#FF6B6B',
        pointBorderColor: '#FFFFFF',
        pointBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          padding: 12,
          titleColor: '#fff',
          bodyColor: '#fff',
          borderColor: '#FF6B6B',
          borderWidth: 1,
          callbacks: {
            title: function(context) {
              const label = context[0].label;
              // Если это период времени, показываем его как есть
              if (/^\d+[mhdwmo]$/.test(label)) {
                return `Period: ${label}`;
              }
              // Если это дата, показываем как дату
              return `Date: ${label}`;
            },
            label: function(context) {
              return formatCurrency(context.parsed.y);
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: 'rgba(255, 255, 255, 0.7)',
            maxRotation: labels.some(l => /^\d+[mhdwmo]$/.test(l)) ? 0 : 45,
            minRotation: labels.some(l => /^\d+[mhdwmo]$/.test(l)) ? 0 : 45
          },
          title: {
            display: true,
            text: labels.some(l => /^\d+[mhdwmo]$/.test(l)) ? 'Time Period' : 'Date',
            color: 'rgba(255, 255, 255, 0.7)'
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: 'rgba(255, 255, 255, 0.1)',
            drawBorder: false
          },
          ticks: {
            color: 'rgba(255, 255, 255, 0.7)',
            callback: function(value) {
              return formatCurrency(value);
            }
          }
        }
      }
    }
  });
}

// Создание графика комиссий
function createFeesChart(poolData) {
  const ctx = document.getElementById('feesChart');
  if (!ctx) return;
  
  if (feesChart) {
    feesChart.destroy();
  }
  
  const fees24h = parseFloat(poolData.fees_24h || poolData.fees?.hour_24 || 0);
  document.getElementById('feesValue').textContent = formatCurrency(fees24h);
  
  const labels = [];
  const feesData = [];
  
  // Извлекаем данные о комиссиях из разных источников
  if (poolData.fees && typeof poolData.fees === 'object' && !Array.isArray(poolData.fees)) {
    const periodOrder = { 'min_30': 1, 'hour_1': 2, 'hour_2': 3, 'hour_4': 4, 'hour_12': 5, 'hour_24': 6, 'day_7': 7 };
    const periods = Object.keys(poolData.fees)
      .filter(key => periodOrder[key])
      .sort((a, b) => (periodOrder[a] || 999) - (periodOrder[b] || 999));
    
    periods.forEach(key => {
      const formatPeriod = (k) => k.replace('min_', '').replace('hour_', '').replace('day_', '');
      labels.push(formatPeriod(key) + (key.includes('min') ? 'm' : key.includes('hour') ? 'h' : 'd'));
      feesData.push(parseFloat(poolData.fees[key] || 0));
    });
  }
  
  if (labels.length === 0) {
    document.querySelector('.fees-section')?.style.setProperty('display', 'none');
    return;
  }
  
  feesChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Fees',
        data: feesData,
        borderColor: '#4CAF50',
        backgroundColor: 'rgba(76, 175, 80, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          callbacks: {
            label: (context) => formatCurrency(context.parsed.y)
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: 'rgba(255, 255, 255, 0.7)' } },
        y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: 'rgba(255, 255, 255, 0.7)', callback: (v) => formatCurrency(v) } }
      }
    }
  });
}

// Создание графика TVL
function createTVLChart(poolData) {
  const ctx = document.getElementById('tvlChart');
  if (!ctx) return;
  
  if (tvlChart) {
    tvlChart.destroy();
  }
  
  const currentTVL = parseFloat(poolData.liquidity || poolData.tvl || 0);
  document.getElementById('tvlValue').textContent = formatCurrency(currentTVL);
  
  // Если нет исторических данных TVL, создаем простой график с текущим значением
  const labels = ['Current'];
  const tvlData = [currentTVL];
  
  // Можно добавить исторические данные, если они доступны
  if (poolData.tvl_history && Array.isArray(poolData.tvl_history) && poolData.tvl_history.length > 0) {
    labels.length = 0;
    tvlData.length = 0;
    poolData.tvl_history.forEach(item => {
      const date = new Date(item.date || item.timestamp * 1000);
      if (!isNaN(date.getTime())) {
        labels.push(date.toLocaleDateString('ru-RU', { month: 'short', day: 'numeric' }));
        tvlData.push(parseFloat(item.tvl || item.value || 0));
      }
    });
  }
  
  if (labels.length === 0) {
    document.querySelector('.tvl-section')?.style.setProperty('display', 'none');
    return;
  }
  
  tvlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'TVL',
        data: tvlData,
        borderColor: '#667eea',
        backgroundColor: 'rgba(102, 126, 234, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          callbacks: {
            label: (context) => formatCurrency(context.parsed.y)
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: 'rgba(255, 255, 255, 0.7)' } },
        y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: 'rgba(255, 255, 255, 0.7)', callback: (v) => formatCurrency(v) } }
      }
    }
  });
}

// Создание графика Fee/TVL
function createFeeTvlChart(poolData) {
  const ctx = document.getElementById('feeTvlChart');
  if (!ctx) return;
  
  if (feeTvlChart) {
    feeTvlChart.destroy();
  }
  
  const feeTvlRatio = parseFloat(poolData.fee_tvl_ratio?.hour_24 || poolData.fee_tvl_ratio || 0) * 100;
  document.getElementById('feeTvlValue').textContent = formatPercent(feeTvlRatio);
  
  const labels = [];
  const ratioData = [];
  
  // Извлекаем данные о Fee/TVL из разных периодов
  if (poolData.fee_tvl_ratio && typeof poolData.fee_tvl_ratio === 'object' && !Array.isArray(poolData.fee_tvl_ratio)) {
    const periodOrder = { 'min_30': 1, 'hour_1': 2, 'hour_2': 3, 'hour_4': 4, 'hour_12': 5, 'hour_24': 6 };
    const periods = Object.keys(poolData.fee_tvl_ratio)
      .filter(key => periodOrder[key])
      .sort((a, b) => (periodOrder[a] || 999) - (periodOrder[b] || 999));
    
    periods.forEach(key => {
      const formatPeriod = (k) => k.replace('min_', '').replace('hour_', '');
      labels.push(formatPeriod(key) + (key.includes('min') ? 'm' : 'h'));
      ratioData.push(parseFloat(poolData.fee_tvl_ratio[key] || 0) * 100);
    });
  }
  
  if (labels.length === 0) {
    document.querySelector('.fee-tvl-section')?.style.setProperty('display', 'none');
    return;
  }
  
  feeTvlChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Fee/TVL %',
        data: ratioData,
        borderColor: '#FF9800',
        backgroundColor: 'rgba(255, 152, 0, 0.1)',
        borderWidth: 2,
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          callbacks: {
            label: (context) => formatPercent(context.parsed.y)
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: 'rgba(255, 255, 255, 0.7)' } },
        y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: 'rgba(255, 255, 255, 0.7)', callback: (v) => formatPercent(v) } }
      }
    }
  });
}

// Создание сравнительного графика объемов
function createVolumeComparisonChart(poolData) {
  const ctx = document.getElementById('volumeComparisonChart');
  if (!ctx) return;
  
  if (volumeComparisonChart) {
    volumeComparisonChart.destroy();
  }
  
  const labels = [];
  const volumes = [];
  
  // Извлекаем объемы за разные периоды
  if (poolData.volume && typeof poolData.volume === 'object' && !Array.isArray(poolData.volume)) {
    const periods = [
      { key: 'min_30', label: '30m' },
      { key: 'hour_1', label: '1h' },
      { key: 'hour_2', label: '2h' },
      { key: 'hour_4', label: '4h' },
      { key: 'hour_12', label: '12h' },
      { key: 'hour_24', label: '24h' },
      { key: 'hour_168', label: '7d' }
    ];
    
    periods.forEach(period => {
      if (poolData.volume[period.key]) {
        labels.push(period.label);
        volumes.push(parseFloat(poolData.volume[period.key] || 0));
      }
    });
  }
  
  if (labels.length === 0) {
    document.querySelector('.volume-comparison-section')?.style.setProperty('display', 'none');
    return;
  }
  
  volumeComparisonChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Volume',
        data: volumes,
        backgroundColor: 'rgba(102, 126, 234, 0.8)',
        borderColor: '#667eea',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          callbacks: {
            label: (context) => formatCurrency(context.parsed.y)
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: 'rgba(255, 255, 255, 0.7)' } },
        y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: 'rgba(255, 255, 255, 0.7)', callback: (v) => formatCurrency(v) } }
      }
    }
  });
}

// Создание графика распределения резервов
function createReservesChart(poolData, tokenXName, tokenYName) {
  const ctx = document.getElementById('reservesChart');
  if (!ctx) return;
  
  if (reservesChart) {
    reservesChart.destroy();
  }
  
  const reserveX = parseFloat(poolData.reserveX || poolData.reserve_x || poolData.tokenX?.reserve || poolData.token_x?.reserve || 0);
  const reserveY = parseFloat(poolData.reserveY || poolData.reserve_y || poolData.tokenY?.reserve || poolData.token_y?.reserve || 0);
  
  // Получаем цены для расчета стоимости в USD
  const price = parseFloat(poolData.price || poolData.current_price || 1);
  const valueX = reserveX * price;
  const valueY = reserveY;
  
  const totalValue = valueX + valueY;
  
  if (totalValue === 0 || (reserveX === 0 && reserveY === 0)) {
    document.querySelector('.reserves-section')?.style.setProperty('display', 'none');
    return;
  }
  
  reservesChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: [tokenXName, tokenYName],
      datasets: [{
        data: [valueX, valueY],
        backgroundColor: ['#00D9FF', '#8B5CF6'],
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: 'rgba(255, 255, 255, 0.9)',
            padding: 15,
            font: { size: 12 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          callbacks: {
            label: (context) => {
              const label = context.label || '';
              const value = context.parsed || 0;
              const percentage = ((value / totalValue) * 100).toFixed(2);
              return `${label}: ${formatCurrency(value)} (${percentage}%)`;
            }
          }
        }
      }
    }
  });
}

// ========== ADMIN PANEL ==========
let positionsRefreshInterval = null;

// Загрузка настроек пулов
async function loadPoolsConfigs() {
  try {
    const response = await fetch('/api/admin/pool-configs');
    if (!response.ok) {
      throw new Error('Failed to load pool configs');
    }
    
    const configs = await response.json();
    const poolsConfigList = document.getElementById('poolsConfigList');
    
    if (!poolsConfigList) return;
    
    const poolAddresses = Object.keys(configs);
    
    if (poolAddresses.length === 0) {
      poolsConfigList.innerHTML = '<p style="text-align: center; color: rgba(255, 255, 255, 0.6); padding: 20px;">Нет сохраненных настроек пулов. Настройки будут созданы при открытии позиции в пуле.</p>';
      return;
    }
    
    poolsConfigList.innerHTML = poolAddresses.map(poolAddress => {
      const config = configs[poolAddress];
      const shortAddress = poolAddress.substring(0, 8) + '...' + poolAddress.substring(poolAddress.length - 8);
      
      return `
        <div class="pool-config-card" data-pool-address="${poolAddress}">
          <div class="pool-config-header">
            <div class="pool-config-address">
              <strong>${shortAddress}</strong>
              <button class="copy-pool-address-btn" data-address="${poolAddress}" title="Копировать адрес">📋</button>
            </div>
            <button class="edit-pool-config-btn" data-pool-address="${poolAddress}">✏️ Редактировать</button>
          </div>
          <div class="pool-config-details">
            <div class="pool-config-detail-item">
              <span class="detail-label">Stop Loss:</span>
              <span class="detail-value">${config.stopLossPercent}%</span>
            </div>
            <div class="pool-config-detail-item">
              <span class="detail-label">Take Profit:</span>
              <span class="detail-value">${config.takeProfitPercent}%</span>
            </div>
            <div class="pool-config-detail-item">
              <span class="detail-label">Mirror Swap:</span>
              <span class="detail-value">${config.mirrorSwap.enabled ? '✅' : '❌'}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
    
    // Добавляем обработчики для кнопок редактирования
    poolsConfigList.querySelectorAll('.edit-pool-config-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const poolAddress = btn.getAttribute('data-pool-address');
        openPoolConfigModal(poolAddress, configs[poolAddress]);
      });
    });
    
    // Добавляем обработчики для кнопок копирования
    poolsConfigList.querySelectorAll('.copy-pool-address-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const address = btn.getAttribute('data-address');
        navigator.clipboard.writeText(address).then(() => {
          btn.textContent = '✓';
          setTimeout(() => {
            btn.textContent = '📋';
          }, 2000);
        });
      });
    });
  } catch (error) {
    console.error('Error loading pool configs:', error);
    const poolsConfigList = document.getElementById('poolsConfigList');
    if (poolsConfigList) {
      poolsConfigList.innerHTML = '<p style="color: #f44336;">Ошибка загрузки настроек пулов</p>';
    }
  }
}

// Открытие модального окна редактирования настроек пула
function openPoolConfigModal(poolAddress, config) {
  const modal = document.getElementById('poolConfigModal');
  if (!modal) return;
  
  // Заполняем форму
  document.getElementById('editPoolAddress').value = poolAddress;
  document.getElementById('editStopLossPercent').value = config.stopLossPercent || -2;
  document.getElementById('editTakeProfitPercent').value = config.takeProfitPercent || 2;
  document.getElementById('editFeeCheckPercent').value = config.feeCheckPercent || 50;
  document.getElementById('editMirrorSwapEnabled').checked = config.mirrorSwap?.enabled || false;
  document.getElementById('editHedgeAmountPercent').value = config.mirrorSwap?.hedgeAmountPercent || 50;
  document.getElementById('editSlippageBps').value = config.mirrorSwap?.slippageBps || 100;
  // averagePriceClose удалено - больше не используется
  
  // Скрываем статус
  const statusEl = document.getElementById('poolConfigModalStatus');
  if (statusEl) {
    statusEl.style.display = 'none';
  }
  
  modal.classList.add('show');
}

// Закрытие модального окна редактирования настроек пула
function closePoolConfigModal() {
  const modal = document.getElementById('poolConfigModal');
  if (modal) {
    modal.classList.remove('show');
  }
}

// Сохранение настроек пула из модального окна
async function savePoolConfigFromModal() {
  const poolAddress = document.getElementById('editPoolAddress').value;
  if (!poolAddress) {
    showPoolConfigModalStatus('Ошибка: адрес пула не найден', 'error');
    return;
  }
  
  const config = {
    stopLossPercent: parseFloat(document.getElementById('editStopLossPercent').value),
    feeCheckPercent: parseFloat(document.getElementById('editFeeCheckPercent').value),
    takeProfitPercent: parseFloat(document.getElementById('editTakeProfitPercent').value),
    mirrorSwap: {
      enabled: document.getElementById('editMirrorSwapEnabled').checked,
      hedgeAmountPercent: parseFloat(document.getElementById('editHedgeAmountPercent').value),
      slippageBps: parseInt(document.getElementById('editSlippageBps').value),
    },
  };
  
  try {
    showPoolConfigModalStatus('Сохранение настроек...', 'info');
    
    const response = await fetch(`/api/admin/pool-config/${poolAddress}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save pool config');
    }
    
    showPoolConfigModalStatus('✅ Настройки пула сохранены!', 'success');
    
    // Перезагружаем список пулов
    setTimeout(() => {
      loadPoolsConfigs();
      closePoolConfigModal();
    }, 1500);
  } catch (error) {
    console.error('Error saving pool config:', error);
    showPoolConfigModalStatus('❌ Ошибка сохранения: ' + (error.message || 'Unknown'), 'error');
  }
}

function showPoolConfigModalStatus(message, type) {
  const el = document.getElementById('poolConfigModalStatus');
  if (!el) return;
  el.style.display = 'block';
  el.className = `rpc-status ${type}`;
  el.querySelector('.status-message').textContent = message;
}

// Загрузка позиций пользователя
async function loadUserPositions() {
  const positionsList = document.getElementById('positionsList');
  if (!positionsList) return;
  
  positionsList.innerHTML = '<p style="color: rgba(255, 255, 255, 0.7);">Загрузка позиций...</p>';
  
  if (!walletPublicKey) {
    positionsList.innerHTML = '<p style="color: rgba(255, 255, 255, 0.7);">Подключите кошелек для просмотра позиций</p>';
    return;
  }
  
  try {
    const response = await fetch(`/api/positions?userAddress=${encodeURIComponent(walletPublicKey)}`);
    if (!response.ok) {
      throw new Error('Failed to load positions');
    }
    
    const positions = await response.json();
    
    if (positions.length === 0) {
      positionsList.innerHTML = '<p style="color: rgba(255, 255, 255, 0.7);">У вас нет открытых позиций</p>';
      return;
    }
    
    // Загружаем расширенную информацию о позициях
    const positionsWithDetails = await Promise.all(positions.map(async (position) => {
      try {
        const detailsResponse = await fetch(`/api/positions/${position.positionAddress}/details`);
        if (detailsResponse.ok) {
          return await detailsResponse.json();
        }
      } catch (error) {
        console.error(`Error loading details for position ${position.positionAddress}:`, error);
      }
      return position;
    }));

    // Отображаем позиции
    const positionsHTML = positionsWithDetails.map(position => {
      const openedDate = new Date(position.openedAt).toLocaleString('ru-RU');
      const statusColors = {
        active: '#4CAF50',
        closed: '#757575',
        pending_close: '#FF9800',
        stop_loss: '#F44336',
        take_profit: '#4CAF50',
      };
      const statusText = {
        active: 'Активна',
        closed: 'Закрыта',
        pending_close: 'Ожидает закрытия',
        stop_loss: 'Stop Loss',
        take_profit: 'Take Profit',
      };

      // Форматирование чисел
      const formatCurrency = (value) => {
        if (!value || isNaN(value)) return '$0.00';
        if (Math.abs(value) >= 1000) {
          return '$' + value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        return '$' + value.toFixed(2);
      };

      const formatPercent = (value) => {
        if (!value || isNaN(value)) return '0.00%';
        const sign = value >= 0 ? '+' : '';
        return sign + value.toFixed(2) + '%';
      };

      // Цвета для P&L
      const pnlColor = position.pnlUSD >= 0 ? '#4CAF50' : '#F44336';
      const priceChangeColor = position.priceChangePercent >= 0 ? '#4CAF50' : '#F44336';
      
      return `
        <div class="position-card" style="padding: 15px; margin-bottom: 15px; background: rgba(15, 15, 30, 0.6); border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.1);">
          <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px;">
            <div>
              <div style="font-weight: 600; color: white; margin-bottom: 5px;">
                Позиция: ${position.positionAddress.substring(0, 8)}...${position.positionAddress.substring(position.positionAddress.length - 6)}
              </div>
              <div style="font-size: 0.85em; color: rgba(255, 255, 255, 0.6);">
                Пул: ${position.poolAddress.substring(0, 8)}...${position.poolAddress.substring(position.poolAddress.length - 6)}
              </div>
            </div>
            <div style="padding: 4px 12px; border-radius: 6px; background: ${statusColors[position.status] || '#757575'}20; color: ${statusColors[position.status] || '#757575'}; font-size: 0.85em; font-weight: 600;">
              ${statusText[position.status] || position.status}
            </div>
          </div>
          
          <!-- Основная стоимость позиции -->
          <div style="margin-top: 15px; padding: 12px; background: rgba(102, 126, 234, 0.1); border-radius: 8px; border: 1px solid rgba(102, 126, 234, 0.3);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <div style="font-size: 0.85em; color: rgba(255, 255, 255, 0.7);">Текущая стоимость позиции</div>
              <div style="font-size: 1.3em; font-weight: 700; color: white;">${formatCurrency(position.currentValueUSD || position.initialValueUSD || 0)}</div>
            </div>
            ${position.initialValueUSD ? `
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8em; color: rgba(255, 255, 255, 0.6);">
                <span>Начальная стоимость:</span>
                <span>${formatCurrency(position.initialValueUSD)}</span>
              </div>
            ` : ''}
          </div>

          <!-- P&L и ROI -->
          ${(position.pnlUSD !== undefined || position.roiPercent !== undefined) ? `
            <div style="margin-top: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
              ${position.pnlUSD !== undefined ? `
                <div style="padding: 10px; background: rgba(255, 255, 255, 0.05); border-radius: 6px;">
                  <div style="font-size: 0.75em; color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">P&L</div>
                  <div style="font-weight: 600; color: ${pnlColor}; font-size: 1.1em;">
                    ${formatCurrency(position.pnlUSD)}
                  </div>
                  ${position.pnlPercent !== undefined ? `
                    <div style="font-size: 0.75em; color: ${pnlColor}; margin-top: 2px;">
                      ${formatPercent(position.pnlPercent)}
                    </div>
                  ` : ''}
                </div>
              ` : ''}
              ${position.roiPercent !== undefined ? `
                <div style="padding: 10px; background: rgba(255, 255, 255, 0.05); border-radius: 6px;">
                  <div style="font-size: 0.75em; color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">ROI</div>
                  <div style="font-weight: 600; color: ${position.roiPercent >= 0 ? '#4CAF50' : '#F44336'}; font-size: 1.1em;">
                    ${formatPercent(position.roiPercent)}
                  </div>
                </div>
              ` : ''}
              ${position.priceChangePercent !== undefined ? `
                <div style="padding: 10px; background: rgba(255, 255, 255, 0.05); border-radius: 6px;">
                  <div style="font-size: 0.75em; color: rgba(255, 255, 255, 0.6); margin-bottom: 4px;">Изменение цены</div>
                  <div style="font-weight: 600; color: ${priceChangeColor}; font-size: 1.1em;">
                    ${formatPercent(position.priceChangePercent)}
                  </div>
                </div>
              ` : ''}
            </div>
          ` : ''}

          <!-- Детальная информация -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.1);">
            <div>
              <div style="font-size: 0.8em; color: rgba(255, 255, 255, 0.6);">Token X</div>
              <div style="color: white; font-weight: 600; font-size: 0.9em;">${(position.tokenXAmount || parseFloat(position.initialTokenXAmount || '0')).toLocaleString('ru-RU', { maximumFractionDigits: 6 })}</div>
              ${position.tokenXPriceUSD ? `
                <div style="font-size: 0.7em; color: rgba(255, 255, 255, 0.5); margin-top: 2px;">
                  ${formatCurrency(position.tokenXPriceUSD)} за токен
                </div>
              ` : ''}
            </div>
            <div>
              <div style="font-size: 0.8em; color: rgba(255, 255, 255, 0.6);">Token Y</div>
              <div style="color: white; font-weight: 600; font-size: 0.9em;">${(position.tokenYAmount || parseFloat(position.initialTokenYAmount || '0')).toLocaleString('ru-RU', { maximumFractionDigits: 6 })}</div>
              ${position.tokenYPriceUSD ? `
                <div style="font-size: 0.7em; color: rgba(255, 255, 255, 0.5); margin-top: 2px;">
                  ${formatCurrency(position.tokenYPriceUSD)} за токен
                </div>
              ` : ''}
            </div>
            <div>
              <div style="font-size: 0.8em; color: rgba(255, 255, 255, 0.6);">Начальная цена</div>
              <div style="color: white; font-weight: 600;">$${parseFloat(position.initialPrice || '0').toFixed(6)}</div>
            </div>
            <div>
              <div style="font-size: 0.8em; color: rgba(255, 255, 255, 0.6);">Текущая цена</div>
              <div style="color: white; font-weight: 600;">$${parseFloat(position.currentPrice || position.initialPrice || '0').toFixed(6)}</div>
            </div>
            <div>
              <div style="font-size: 0.8em; color: rgba(255, 255, 255, 0.6);">Открыта</div>
              <div style="color: white; font-size: 0.85em;">${openedDate}</div>
              ${position.timeInPositionDays ? `
                <div style="font-size: 0.7em; color: rgba(255, 255, 255, 0.5); margin-top: 2px;">
                  ${position.timeInPositionDays.toFixed(1)} дн.
                </div>
              ` : ''}
            </div>
          </div>
          
          ${(position.accumulatedFees > 0 || position.timeInPositionHours) ? `
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: flex; justify-content: space-between; gap: 15px; flex-wrap: wrap;">
              ${position.accumulatedFees > 0 ? `
                <div>
                  <div style="font-size: 0.8em; color: rgba(255, 255, 255, 0.6);">Накопленные комиссии</div>
                  <div style="color: #4CAF50; font-weight: 600;">${formatCurrency(position.accumulatedFees)}</div>
                </div>
              ` : ''}
            </div>
          ` : ''}
          
          <!-- История Mirror Swaps -->
          ${position.hedgeSwapsHistory && position.hedgeSwapsHistory.length > 0 ? `
            <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid rgba(255, 255, 255, 0.1);">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <div style="font-weight: 600; color: white; font-size: 0.95em;">
                  🔄 Mirror Swaps (${position.hedgeSwapsHistory.length})
                </div>
                <button 
                  class="toggle-hedge-history-btn" 
                  data-position-address="${position.positionAddress}"
                  style="background: rgba(102, 126, 234, 0.2); color: #667eea; border: 1px solid rgba(102, 126, 234, 0.4); border-radius: 6px; padding: 6px 12px; font-size: 0.85em; cursor: pointer; transition: all 0.2s;"
                  onmouseover="this.style.background='rgba(102, 126, 234, 0.3)'"
                  onmouseout="this.style.background='rgba(102, 126, 234, 0.2)'"
                >
                  Показать
                </button>
              </div>
              <div 
                class="hedge-history-container" 
                data-position-address="${position.positionAddress}"
                style="display: none; max-height: 300px; overflow-y: auto; background: rgba(0, 0, 0, 0.3); border-radius: 8px; padding: 10px;"
              >
                ${position.hedgeSwapsHistory.slice().reverse().slice(0, 10).map(swap => {
                  const swapDate = new Date(swap.timestamp).toLocaleString('ru-RU');
                  const directionColor = swap.direction === 'buy' ? '#4CAF50' : '#F44336';
                  const directionIcon = swap.direction === 'buy' ? '⬆️' : '⬇️';
                  const priceChangeColor = swap.priceChangePercent >= 0 ? '#4CAF50' : '#F44336';
                  return `
                    <div style="padding: 10px; margin-bottom: 8px; background: rgba(255, 255, 255, 0.05); border-radius: 6px; border-left: 3px solid ${directionColor};">
                      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 6px;">
                        <div style="display: flex; align-items: center; gap: 8px;">
                          <span style="font-size: 1.2em;">${directionIcon}</span>
                          <span style="font-weight: 600; color: ${directionColor}; text-transform: uppercase;">${swap.direction === 'buy' ? 'Покупка' : 'Продажа'}</span>
                          <span style="color: white; font-weight: 600;">${parseFloat(swap.amount).toFixed(6)}</span>
                        </div>
                        <div style="font-size: 0.75em; color: rgba(255, 255, 255, 0.5);">${swapDate}</div>
                      </div>
                      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; font-size: 0.8em;">
                        <div>
                          <span style="color: rgba(255, 255, 255, 0.6);">Цена:</span>
                          <span style="color: white; margin-left: 4px;">$${parseFloat(swap.price).toFixed(6)}</span>
                        </div>
                        <div>
                          <span style="color: rgba(255, 255, 255, 0.6);">Изменение:</span>
                          <span style="color: ${priceChangeColor}; margin-left: 4px;">${swap.priceChangePercent >= 0 ? '+' : ''}${swap.priceChangePercent.toFixed(2)}%</span>
                        </div>
                        <div style="grid-column: 1 / -1;">
                          <span style="color: rgba(255, 255, 255, 0.6);">Транзакция:</span>
                          <a href="https://solscan.io/tx/${swap.signature}" target="_blank" style="color: #667eea; text-decoration: none; margin-left: 4px; word-break: break-all;">
                            ${swap.signature.substring(0, 16)}...
                          </a>
                        </div>
                      </div>
                    </div>
                  `;
                }).join('')}
                ${position.hedgeSwapsHistory.length > 10 ? `
                  <div style="text-align: center; padding: 8px; color: rgba(255, 255, 255, 0.5); font-size: 0.85em;">
                    Показаны последние 10 из ${position.hedgeSwapsHistory.length} swaps
                  </div>
                ` : ''}
              </div>
            </div>
          ` : ''}
          
        </div>
      `;
    }).join('');
    
    positionsList.innerHTML = positionsHTML;
    
    // Обновляем статистику после загрузки позиций
    await updateAdminStats();
    
    // Добавляем обработчики для кнопок показа/скрытия истории hedge swaps
    positionsList.querySelectorAll('.toggle-hedge-history-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const positionAddress = btn.getAttribute('data-position-address');
        const historyContainer = positionsList.querySelector(`.hedge-history-container[data-position-address="${positionAddress}"]`);
        if (historyContainer) {
          const isVisible = historyContainer.style.display !== 'none';
          historyContainer.style.display = isVisible ? 'none' : 'block';
          btn.textContent = isVisible ? 'Показать' : 'Скрыть';
        }
      });
    });
  } catch (error) {
    console.error('Error loading positions:', error);
    positionsList.innerHTML = '<p style="color: #F44336;">Ошибка загрузки позиций: ' + error.message + '</p>';
  }
}

// Открыть модальное окно настроек позиции
async function openPositionSettingsModal(positionAddress) {
  if (!positionAddress) {
    console.error('Position address is required');
    return;
  }
  
  try {
    // Загружаем данные позиции
    const response = await fetch(`/api/positions/${positionAddress}`);
    if (!response.ok) {
      throw new Error('Failed to load position');
    }
    
    const position = await response.json();
    
    // Заполняем форму текущими значениями
    const autoClaimEnabled = document.getElementById('positionAutoClaimEnabled');
    const autoClaimThreshold = document.getElementById('positionAutoClaimThreshold');
    
    if (autoClaimEnabled && autoClaimThreshold) {
      autoClaimEnabled.checked = position.autoClaim?.enabled || false;
      autoClaimThreshold.value = position.autoClaim?.thresholdUSD || '1.0';
    }
    
    // Сохраняем адрес позиции для сохранения
    const positionSettingsModal = document.getElementById('positionSettingsModal');
    if (positionSettingsModal) {
      positionSettingsModal.dataset.positionAddress = positionAddress;
      positionSettingsModal.classList.add('show');
    }
  } catch (error) {
    console.error('Error opening position settings modal:', error);
    alert('Ошибка загрузки данных позиции: ' + error.message);
  }
}

// Сохранить настройки позиции
async function savePositionSettings() {
  const positionSettingsModal = document.getElementById('positionSettingsModal');
  if (!positionSettingsModal) {
    return;
  }
  
  const positionAddress = positionSettingsModal.dataset.positionAddress;
  if (!positionAddress) {
    console.error('Position address not found');
    return;
  }
  
  const autoClaimEnabled = document.getElementById('positionAutoClaimEnabled')?.checked || false;
  const autoClaimThreshold = parseFloat(document.getElementById('positionAutoClaimThreshold')?.value || '0');
  
  const autoClaim = autoClaimEnabled && autoClaimThreshold > 0 ? {
    enabled: true,
    thresholdUSD: autoClaimThreshold,
  } : undefined;
  
  const statusEl = document.getElementById('positionSettingsStatus');
  const statusMessage = statusEl?.querySelector('.status-message');
  
  try {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'rpc-status info';
      if (statusMessage) statusMessage.textContent = 'Сохранение настроек...';
    }
    
    const response = await fetch(`/api/positions/${positionAddress}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        autoClaim,
      }),
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'Failed to update position settings');
    }
    
    if (statusEl) {
      statusEl.className = 'rpc-status success';
      if (statusMessage) statusMessage.textContent = '✅ Настройки успешно сохранены';
    }
    
    // Обновляем список позиций
    await loadUserPositions();
    await loadPositions();
    
    // Закрываем модальное окно через 1.5 секунды
    setTimeout(() => {
      if (positionSettingsModal) {
        positionSettingsModal.classList.remove('show');
      }
      if (statusEl) {
        statusEl.style.display = 'none';
      }
    }, 1500);
  } catch (error) {
    console.error('Error saving position settings:', error);
    if (statusEl) {
      statusEl.className = 'rpc-status error';
      if (statusMessage) statusMessage.textContent = '❌ Ошибка: ' + error.message;
    }
  }
}

// Закрытие позиции
async function closePosition(positionAddress, poolAddress) {
  if (!walletPublicKey) {
    alert('Подключите кошелек для закрытия позиции');
    return;
  }
  
  if (!confirm(`Вы уверены, что хотите закрыть позицию ${positionAddress.substring(0, 8)}...${positionAddress.substring(positionAddress.length - 6)}?`)) {
    return;
  }
  
  try {
    // Показываем статус загрузки
    const positionsList = document.getElementById('positionsList');
    if (positionsList) {
      const statusEl = document.createElement('div');
      statusEl.id = 'closePositionStatus';
      statusEl.style.cssText = 'padding: 15px; margin-bottom: 15px; background: rgba(255, 193, 7, 0.1); border: 1px solid rgba(255, 193, 7, 0.3); border-radius: 8px; color: #ffc107;';
      statusEl.textContent = 'Закрытие позиции...';
      positionsList.insertBefore(statusEl, positionsList.firstChild);
    }
    
    // Запрашиваем транзакцию закрытия позиции
    const res = await fetch('/api/meteora/close-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        poolAddress,
        positionAddress,
        userPublicKey: walletPublicKey,
      }),
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to create close position transaction');
    }
    
    const { transaction: txBase64 } = data;
    
    // Десериализуем транзакцию
    const txBytes = Uint8Array.from(atob(txBase64), c => c.charCodeAt(0));
    const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);
    
    // Подписываем пользовательским кошельком через Phantom
    const provider = getPhantomProvider();
    if (!provider) {
      throw new Error('Phantom не найден');
    }
    
    const signed = await provider.signTransaction(tx);
    
    // Отправляем через наш сервер
    const signedBase64 = btoa(String.fromCharCode(...signed.serialize()));
    const sendRes = await fetch('/api/tx/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTxBase64: signedBase64 }),
    });
    
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      throw new Error(sendData.error || 'Send failed');
    }
    
    const sig = sendData.signature;
    
    // Обновляем статус позиции в базе данных
    try {
      await fetch(`/api/positions/${positionAddress}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (updateError) {
      console.warn('Failed to update position status:', updateError);
      // Не прерываем процесс, позиция уже закрыта в блокчейне
    }
    
    // Обновляем статус
    const statusEl = document.getElementById('closePositionStatus');
    if (statusEl) {
      statusEl.style.cssText = 'padding: 15px; margin-bottom: 15px; background: rgba(76, 175, 80, 0.1); border: 1px solid rgba(76, 175, 80, 0.3); border-radius: 8px; color: #4CAF50;';
      statusEl.textContent = `✅ Позиция закрыта! Signature: ${sig}`;
      setTimeout(() => {
        statusEl.remove();
      }, 10000); // Увеличиваем время до 10 секунд
    }
    
    // Показываем заметное уведомление об успешном закрытии
    showSuccessNotification(
      `✅ Позиция успешно закрыта!`,
      `Позиция ${positionAddress.substring(0, 8)}...${positionAddress.substring(positionAddress.length - 6)} была закрыта.`,
      sig
    );
    
    // Обновляем список позиций
    await loadUserPositions();
    // Обновляем статистику
    await updateAdminStats();
    
  } catch (error) {
    console.error('Error closing position:', error);
    const statusEl = document.getElementById('closePositionStatus');
    if (statusEl) {
      statusEl.style.cssText = 'padding: 15px; margin-bottom: 15px; background: rgba(244, 67, 54, 0.1); border: 1px solid rgba(244, 67, 54, 0.3); border-radius: 8px; color: #F44336;';
      statusEl.textContent = `❌ Ошибка закрытия позиции: ${error.message}`;
    } else {
      alert(`Ошибка закрытия позиции: ${error.message}`);
    }
  }
}

// Загрузка позиций (для админ панели)
async function loadAdminPositions() {
  // Используем ту же функцию для загрузки позиций пользователя
  await loadUserPositions();
}

// Обновление статистики
async function updateAdminStats() {
  try {
    if (!walletPublicKey) {
      // Если кошелек не подключен, показываем нули
      document.getElementById('activePositionsCount').textContent = '0';
      document.getElementById('closedPositionsCount').textContent = '0';
      document.getElementById('totalFees').textContent = '$0.00';
      return;
    }
    
    const response = await fetch(`/api/positions/stats?userAddress=${encodeURIComponent(walletPublicKey)}`);
    if (!response.ok) {
      throw new Error('Failed to load stats');
    }
    
    const stats = await response.json();
    
    // Обновляем статистику
    document.getElementById('activePositionsCount').textContent = String(stats.activePositionsCount || 0);
    document.getElementById('closedPositionsCount').textContent = String(stats.closedPositionsCount || 0);
    
    // Форматируем комиссии
    const formatCurrency = (value) => {
      if (!value || isNaN(value) || value === 0) return '$0.00';
      if (Math.abs(value) >= 1000) {
        return '$' + value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return '$' + value.toFixed(2);
    };
    
    document.getElementById('totalFees').textContent = formatCurrency(stats.totalFees || 0);
  } catch (error) {
    console.error('Error updating admin stats:', error);
    // При ошибке показываем нули
    document.getElementById('activePositionsCount').textContent = '0';
    document.getElementById('closedPositionsCount').textContent = '0';
    document.getElementById('totalFees').textContent = '$0.00';
  }
}

// Инициализация админ панели
function initAdminPanel() {
  // Загружаем настройки пулов
  loadPoolsConfigs();
  
  // Обработчики модального окна редактирования настроек пула
  const closePoolConfigModalBtn = document.getElementById('closePoolConfigModalBtn');
  if (closePoolConfigModalBtn) {
    closePoolConfigModalBtn.addEventListener('click', closePoolConfigModal);
  }
  
  const savePoolConfigBtn = document.getElementById('savePoolConfigBtn');
  if (savePoolConfigBtn) {
    savePoolConfigBtn.addEventListener('click', savePoolConfigFromModal);
  }
  
  // Инициализация модального окна настроек позиции
  const positionSettingsModal = document.getElementById('positionSettingsModal');
  const closePositionSettingsModalBtn = document.getElementById('closePositionSettingsModalBtn');
  if (closePositionSettingsModalBtn) {
    closePositionSettingsModalBtn.addEventListener('click', () => {
      if (positionSettingsModal) {
        positionSettingsModal.classList.remove('show');
      }
    });
  }
  
  const savePositionSettingsBtn = document.getElementById('savePositionSettingsBtn');
  if (savePositionSettingsBtn) {
    savePositionSettingsBtn.addEventListener('click', savePositionSettings);
  }
  
  // Закрытие модального окна при клике вне его
  if (positionSettingsModal) {
    positionSettingsModal.addEventListener('click', (e) => {
      if (e.target === positionSettingsModal) {
        positionSettingsModal.classList.remove('show');
      }
    });
  }
  
  const poolConfigModal = document.getElementById('poolConfigModal');
  if (poolConfigModal) {
    poolConfigModal.addEventListener('click', (e) => {
      if (e.target.id === 'poolConfigModal') {
        closePoolConfigModal();
      }
    });
  }
  
  // Загружаем позиции и статистику
  loadAdminPositions();
  updateAdminStats();
  
  // Обновляем каждые 10 секунд
  if (positionsRefreshInterval) {
    clearInterval(positionsRefreshInterval);
  }
  positionsRefreshInterval = setInterval(() => {
    loadAdminPositions();
    updateAdminStats();
    loadPoolsConfigs(); // Обновляем список пулов
  }, 10000);
}

// ========== WALLET SETTINGS API ==========
async function saveWalletSettings(settings) {
  try {
    const response = await fetch('/api/settings/wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });

    if (!response.ok) throw new Error('Ошибка сохранения настроек кошелька');
    console.log('Wallet settings saved');
  } catch (error) {
    console.error('Error saving wallet settings:', error);
  }
}

async function loadWalletSettings() {
  try {
    const response = await fetch('/api/settings/wallet');
    if (!response.ok) return;

    const settings = await response.json();
    if (settings && settings.connected && settings.publicKey) {
      walletPublicKey = settings.publicKey;
      // Try to reconnect (user will need to approve in Phantom)
      const provider = getPhantomProvider();
      if (provider && provider.isConnected) {
        phantomWallet = provider;
        updateWalletUI();
        await updateWalletBalance();
        // Загружаем позиции пользователя
        await loadUserPositions();
        // Обновляем статистику
        await updateAdminStats();
      }
    }
  } catch (error) {
    console.error('Error loading wallet settings:', error);
  }
}



