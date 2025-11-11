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
  binStepMin: null,
  binStepMax: null,
  liquidityMin: null,
  liquidityMax: null,
  volumePeriod: 'hour_24',
  volumePeriodMin: null,
  feesPeriod: 'hour_24',
  feesPeriodMin: null,
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
}

// Применение фильтров и сортировки
function applyFilters() {
  console.log('🔍 ========== НАЧАЛО ФИЛЬТРАЦИИ ==========');
  console.log('📊 Всего пулов в базе:', allPools.length);
  
  const searchTerm = document.getElementById('searchInput').value.toLowerCase();
  const sortValue = document.getElementById('sortSelect').value;
  
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
  
  // Применяем дополнительные фильтры
  filteredPools = poolsToFilter.filter((pool) => {
    // Verified filter
    if (filters.verified) {
      if (!pool.is_verified) {
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
  
  // Отображаем только первые displayedCount пулов
  const poolsToDisplay = filteredPools.slice(0, displayedCount);
  const hasMore = filteredPools.length > displayedCount;
  
  containerEl.innerHTML = poolsToDisplay.map(pool => {
    const liquidity = parseFloat(pool.liquidity || 0);
    const volume24h = parseFloat(pool.trade_volume_24h || 0);
    const fees24h = parseFloat(pool.fees_24h || 0);
    const apr = parseFloat(pool.apr || 0);
    const apy = parseFloat(pool.apy || 0);
    const baseFee = parseFloat(pool.base_fee_percentage || 0);
    
    return `
      <div class="pool-card">
        <div class="pool-header">
          <div class="pool-name">${pool.name || 'Unknown'}</div>
          ${pool.is_verified ? '<span class="pool-verified">✓ Verified</span>' : ''}
        </div>
        <div class="pool-address">${pool.address}</div>
        <div class="pool-info">
          <div class="pool-info-item">
            <span class="pool-info-label">Ликвидность</span>
            <span class="pool-info-value">${formatCurrency(liquidity)}</span>
          </div>
          <div class="pool-info-item">
            <span class="pool-info-label">Объем 24ч</span>
            <span class="pool-info-value">${formatCurrency(volume24h)}</span>
          </div>
          <div class="pool-info-item">
            <span class="pool-info-label">Комиссии 24ч</span>
            <span class="pool-info-value">${formatCurrency(fees24h)}</span>
          </div>
          <div class="pool-info-item">
            <span class="pool-info-label">Базовая комиссия</span>
            <span class="pool-info-value">${formatPercent(baseFee)}</span>
          </div>
        </div>
        ${apr > 0 || apy > 0 ? `
          <div class="pool-apr ${apr === 0 ? 'zero' : ''}">
            APR: ${formatPercent(apr)} | APY: ${formatPercent(apy)}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  // Показываем/скрываем кнопку "Загрузить еще"
  if (hasMore) {
    loadMoreContainer.style.display = 'block';
    poolsInfo.textContent = `Показано ${poolsToDisplay.length} из ${filteredPools.length} пулов`;
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
  document.getElementById('filterBinStepMin').value = filters.binStepMin || '';
  document.getElementById('filterBinStepMax').value = filters.binStepMax || '';
  document.getElementById('filterLiquidityMin').value = filters.liquidityMin || '';
  document.getElementById('filterLiquidityMax').value = filters.liquidityMax || '';
  document.getElementById('filterVolumePeriod').value = filters.volumePeriod;
  document.getElementById('filterVolumePeriodMin').value = filters.volumePeriodMin || '';
  document.getElementById('filterFeesPeriod').value = filters.feesPeriod;
  document.getElementById('filterFeesPeriodMin').value = filters.feesPeriodMin || '';
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
    binStepMin: null,
    binStepMax: null,
    liquidityMin: null,
    liquidityMax: null,
    volumePeriod: 'hour_24',
    volumePeriodMin: null,
    feesPeriod: 'hour_24',
    feesPeriodMin: null,
    feeTvlPeriod: 'hour_24',
    feeTvlPeriodMin: null,
    aprMin: null,
    aprMax: null,
    launchpads: [],
    lfg: false
  };
  
  // Очищаем форму
  document.getElementById('filterVerified').checked = false;
  document.getElementById('filterBinStepMin').value = '';
  document.getElementById('filterBinStepMax').value = '';
  document.getElementById('filterLiquidityMin').value = '';
  document.getElementById('filterLiquidityMax').value = '';
  document.getElementById('filterVolumePeriod').value = 'hour_24';
  document.getElementById('filterVolumePeriodMin').value = '';
  document.getElementById('filterFeesPeriod').value = 'hour_24';
  document.getElementById('filterFeesPeriodMin').value = '';
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
  console.log(`   - Launchpads (${filters.launchpads.length}):`, filters.launchpads);
  console.log(`   - LFG: ${filters.lfg}`);
  console.log(`   - Liquidity: ${filters.liquidityMin || 'мин нет'} - ${filters.liquidityMax || 'макс нет'}`);
  console.log(`   - Volume (${filters.volumePeriod}): мин ${filters.volumePeriodMin || 'нет'}`);
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
  const tabButtons = document.querySelectorAll('.tab-btn');
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
    });
  });
}

// Инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
  // Initialize launchpad list
  initLaunchpadList();

  // Обработчики событий для фильтров
  const searchInput = document.getElementById('searchInput');
  const sortSelect = document.getElementById('sortSelect');
  const refreshBtn = document.getElementById('refreshBtn');
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  const filterBtn = document.getElementById('filterBtn');
  const closeFilterBtn = document.getElementById('closeFilterBtn');
  const resetFilterBtn = document.getElementById('resetFilterBtn');
  const saveFilterBtn = document.getElementById('saveFilterBtn');
  const selectAllLaunchpads = document.getElementById('selectAllLaunchpads');

  if (searchInput) searchInput.addEventListener('input', applyFilters);
  if (sortSelect) sortSelect.addEventListener('change', applyFilters);
  if (refreshBtn) refreshBtn.addEventListener('click', refreshPools);
  if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMorePools);
  if (filterBtn) filterBtn.addEventListener('click', openFilterModal);
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

function handleWalletDisconnect() {
  phantomWallet = null;
  walletPublicKey = null;
  walletBalance = null;
  updateWalletUI();
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
      }
    }
  } catch (error) {
    console.error('Error loading wallet settings:', error);
  }
}


