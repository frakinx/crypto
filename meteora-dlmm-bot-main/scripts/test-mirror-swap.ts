/**
 * Скрипт для тестирования математики Mirror Swap
 * 
 * Использование:
 *   npx tsx scripts/test-mirror-swap.ts
 * 
 * Этот скрипт проверяет правильность расчетов hedge amount
 * согласно формуле: h = 0.5 · (P₀ − P)/P₀
 */

interface TestCase {
  name: string;
  initialPrice: number;
  currentPrice: number;
  hedgePercent: number;
  positionValueUSD: number;
  expectedHedgeRatio: number;
  expectedDirection: 'buy' | 'sell';
  expectedHedgeValueUSD: number;
}

const testCases: TestCase[] = [
  {
    name: 'Цена упала на 5%',
    initialPrice: 100,
    currentPrice: 95,
    hedgePercent: 50,
    positionValueUSD: 1000,
    expectedHedgeRatio: 0.5 * 0.5 * (100 - 95) / 100, // 0.0125
    expectedDirection: 'sell',
    expectedHedgeValueUSD: 1000 * 0.0125, // 12.5
  },
  {
    name: 'Цена выросла на 5%',
    initialPrice: 100,
    currentPrice: 105,
    hedgePercent: 50,
    positionValueUSD: 1000,
    expectedHedgeRatio: 0.5 * 0.5 * (100 - 105) / 100, // -0.0125
    expectedDirection: 'buy',
    expectedHedgeValueUSD: 1000 * 0.0125, // 12.5
  },
  {
    name: 'Цена упала на 10%',
    initialPrice: 100,
    currentPrice: 90,
    hedgePercent: 100,
    positionValueUSD: 1000,
    expectedHedgeRatio: 1.0 * 0.5 * (100 - 90) / 100, // 0.05
    expectedDirection: 'sell',
    expectedHedgeValueUSD: 1000 * 0.05, // 50
  },
  {
    name: 'Инкрементальный hedge: цена упала с 100 до 95, затем до 90',
    initialPrice: 100,
    currentPrice: 90,
    hedgePercent: 50,
    positionValueUSD: 1000,
    // Используем lastHedgePrice = 95 для инкрементального расчета
    expectedHedgeRatio: 0.5 * 0.5 * (95 - 90) / 95, // ~0.01316
    expectedDirection: 'sell',
    expectedHedgeValueUSD: 1000 * 0.01316, // ~13.16
  },
];

function calculateHedgeRatio(
  basePrice: number,
  currentPrice: number,
  hedgePercent: number,
): number {
  const priceChange = (basePrice - currentPrice) / basePrice;
  const hedgeRatio = (hedgePercent / 100) * 0.5 * priceChange;
  return hedgeRatio;
}

function calculateDirection(priceChange: number): 'buy' | 'sell' {
  return priceChange < 0 ? 'buy' : 'sell';
}

function runTests(): void {
  console.log('🧪 Тестирование математики Mirror Swap\n');
  console.log('Формула: h = (hedgePercent / 100) * 0.5 * (P₀ − P) / P₀\n');
  
  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    console.log(`📋 Тест: ${testCase.name}`);
    console.log(`   Начальная цена: $${testCase.initialPrice}`);
    console.log(`   Текущая цена: $${testCase.currentPrice}`);
    console.log(`   Hedge процент: ${testCase.hedgePercent}%`);
    console.log(`   Стоимость позиции: $${testCase.positionValueUSD}`);
    
    const hedgeRatio = calculateHedgeRatio(
      testCase.initialPrice,
      testCase.currentPrice,
      testCase.hedgePercent,
    );
    
    const direction = calculateDirection(
      (testCase.initialPrice - testCase.currentPrice) / testCase.initialPrice,
    );
    
    const hedgeValueUSD = testCase.positionValueUSD * Math.abs(hedgeRatio);
    
    // Проверяем результаты
    const ratioMatch = Math.abs(hedgeRatio - testCase.expectedHedgeRatio) < 0.0001;
    const directionMatch = direction === testCase.expectedDirection;
    const valueMatch = Math.abs(hedgeValueUSD - testCase.expectedHedgeValueUSD) < 0.01;
    
    console.log(`   Рассчитанный hedge ratio: ${hedgeRatio.toFixed(6)}`);
    console.log(`   Ожидаемый hedge ratio: ${testCase.expectedHedgeRatio.toFixed(6)}`);
    console.log(`   Направление: ${direction} (ожидается: ${testCase.expectedDirection})`);
    console.log(`   Стоимость hedge: $${hedgeValueUSD.toFixed(2)} (ожидается: $${testCase.expectedHedgeValueUSD.toFixed(2)})`);
    
    if (ratioMatch && directionMatch && valueMatch) {
      console.log(`   ✅ ТЕСТ ПРОЙДЕН\n`);
      passed++;
    } else {
      console.log(`   ❌ ТЕСТ НЕ ПРОЙДЕН`);
      if (!ratioMatch) console.log(`      - Hedge ratio не совпадает`);
      if (!directionMatch) console.log(`      - Направление не совпадает`);
      if (!valueMatch) console.log(`      - Стоимость hedge не совпадает`);
      console.log('');
      failed++;
    }
  }
  
  console.log('\n📊 Результаты тестирования:');
  console.log(`   ✅ Пройдено: ${passed}`);
  console.log(`   ❌ Провалено: ${failed}`);
  console.log(`   Всего: ${testCases.length}`);
  
  if (failed === 0) {
    console.log('\n🎉 Все тесты пройдены успешно!');
  } else {
    console.log('\n⚠️ Некоторые тесты провалены. Проверьте логику расчета.');
  }
}

// Запускаем тесты
runTests();

