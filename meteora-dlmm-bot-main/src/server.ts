import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { getConnection } from './rpc.js';
import { getQuote as jupGetQuote, createSwapTransaction as jupCreateSwapTx } from './dex/jupiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware для парсинга JSON
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Путь к файлу настроек
const SETTINGS_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');

// Создаем директорию data если её нет
if (!fs.existsSync(SETTINGS_DIR)) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
}

// Функции для работы с настройками
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
  return {};
}

function saveSettings(newSettings: any) {
  try {
    const current = loadSettings();
    // Merge settings properly
    const updated = {
      ...current,
      ...newSettings,
      // Merge nested objects if they exist
      wallet: newSettings.wallet !== undefined ? newSettings.wallet : current.wallet,
      proxy: newSettings.proxy !== undefined ? newSettings.proxy : current.proxy,
      rpc: newSettings.rpc !== undefined ? newSettings.rpc : current.rpc,
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2));
    return updated;
  } catch (error) {
    console.error('Error saving settings:', error);
    throw error;
  }
}

// API endpoint для получения пулов
app.get('/api/pools', async (req, res) => {
  try {
    const response = await fetch('https://dlmm-api.meteora.ag/pair/all');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Error fetching pools:', error);
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

// API endpoint для получения детальной информации о пуле
app.get('/api/pool/:address', async (req, res) => {
  try {
    const { address } = req.params;
    if (!address) {
      return res.status(400).json({ error: 'Pool address is required' });
    }

    // Получаем детальную информацию о пуле
    const poolResponse = await fetch(`https://dlmm-api.meteora.ag/pair/${address}`);
    if (!poolResponse.ok) {
      throw new Error(`HTTP error! status: ${poolResponse.status}`);
    }
    const poolData = await poolResponse.json();

    // Получаем распределение ликвидности (bins)
    let liquidityDistribution = null;
    try {
      const binsResponse = await fetch(`https://dlmm-api.meteora.ag/pair/${address}/bins`);
      if (binsResponse.ok) {
        liquidityDistribution = await binsResponse.json();
      }
    } catch (binsError) {
      console.warn('Could not fetch bins data:', binsError);
      // Продолжаем без данных о bins
    }

    // Получаем исторические данные о торговом объеме
    let volumeHistory = null;
    try {
      // Пробуем разные возможные endpoints для получения исторических данных
      const endpoints = [
        `https://dlmm-api.meteora.ag/pair/${address}/volume/history`,
        `https://dlmm-api.meteora.ag/pair/${address}/volume/daily`,
        `https://dlmm-api.meteora.ag/pair/${address}/history`,
        `https://dlmm-api.meteora.ag/pair/${address}/stats`,
        `https://dlmm-api.meteora.ag/pair/${address}/volume`
      ];
      
      for (const endpoint of endpoints) {
        try {
          const volumeResponse = await fetch(endpoint);
          if (volumeResponse.ok) {
            const data = await volumeResponse.json();
            // Проверяем, что это действительно исторические данные (массив или объект с датами)
            if (Array.isArray(data) || (typeof data === 'object' && data !== null && 
                (data.history || data.daily || data.data || Object.keys(data).some(k => /^\d{4}-\d{2}-\d{2}/.test(k))))) {
              volumeHistory = data;
              console.log(`Volume history fetched from ${endpoint} for pool ${address}:`, volumeHistory);
              break;
            }
          }
        } catch (err) {
          // Продолжаем пробовать другие endpoints
          continue;
        }
      }
      
      if (!volumeHistory) {
        console.log(`No volume history endpoint found for pool ${address}`);
      }
    } catch (volumeError) {
      console.warn('Could not fetch volume history data:', volumeError);
      // Продолжаем без исторических данных
    }

    // Логируем структуру данных пула для отладки
    console.log(`Pool data keys for ${address}:`, Object.keys(poolData));
    console.log(`Volume-related fields:`, Object.keys(poolData).filter(key => 
      key.toLowerCase().includes('volume') || key.toLowerCase().includes('trade')
    ));

    res.json({
      ...poolData,
      liquidityDistribution,
      volumeHistory
    });
  } catch (error) {
    console.error('Error fetching pool details:', error);
    res.status(500).json({ error: 'Failed to fetch pool details' });
  }
});

// API endpoint для получения баланса кошелька
app.get('/api/wallet/balance', async (req, res) => {
  try {
    const address = req.query.address as string;
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    // Use fixed Helius RPC connection
    const connection = getConnection();
    
    const publicKey = new PublicKey(address);
    
    // Используем Promise.race для добавления таймаута (уменьшили до 8 секунд)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout: RPC сервер не ответил за 8 секунд. Попробуйте использовать более быстрый RPC endpoint (например, Helius, QuickNode или приватный RPC).')), 8000);
    });
    
    const balancePromise = connection.getBalance(publicKey, 'confirmed');
    
    const balance = await Promise.race([balancePromise, timeoutPromise]);
    const solBalance = balance / 1e9;

    res.json({ balance: solBalance, lamports: balance });
  } catch (error) {
    console.error('Error fetching balance:', error);
    const errorMessage = (error as Error).message;
    
    // Более понятные сообщения об ошибках
    if (errorMessage.includes('Timeout')) {
      res.status(504).json({ error: 'Таймаут: RPC сервер не отвечает. Попробуйте использовать другой RPC endpoint или проверьте настройки RPC.' });
    } else if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
      res.status(503).json({ error: 'Не удалось подключиться к RPC серверу. Проверьте настройки RPC и убедитесь, что URL правильный.' });
    } else if (errorMessage.includes('<!DOCTYPE') || errorMessage.includes('<html') || 
               (errorMessage.includes('Unexpected token') && errorMessage.includes('DOCTYPE'))) {
      res.status(502).json({ error: 'RPC endpoint вернул HTML вместо JSON. Это означает проблему с API key. Проверьте ключ в дашборде Helius и убедитесь, что он активен и имеет доступ к mainnet.' });
    } else {
      res.status(500).json({ error: 'Ошибка получения баланса: ' + errorMessage });
    }
  }
});

// API endpoints для настроек кошелька
app.get('/api/settings/wallet', (req, res) => {
  try {
    const settings = loadSettings();
    res.json(settings.wallet || {});
  } catch (error) {
    console.error('Error loading wallet settings:', error);
    res.status(500).json({ error: 'Failed to load wallet settings' });
  }
});

app.post('/api/settings/wallet', (req, res) => {
  try {
    const walletSettings = req.body;
    saveSettings({ wallet: walletSettings });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving wallet settings:', error);
    res.status(500).json({ error: 'Failed to save wallet settings' });
  }
});

// API endpoints для настроек прокси
app.get('/api/settings/proxy', (req, res) => {
  try {
    const settings = loadSettings();
    res.json(settings.proxy || {});
  } catch (error) {
    console.error('Error loading proxy settings:', error);
    res.status(500).json({ error: 'Failed to load proxy settings' });
  }
});

app.post('/api/settings/proxy', (req, res) => {
  try {
    const proxySettings = req.body;
    saveSettings({ proxy: proxySettings });
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving proxy settings:', error);
    res.status(500).json({ error: 'Failed to save proxy settings' });
  }
});

app.post('/api/settings/proxy/test', async (req, res) => {
  try {
    const { type, host, port, username, password } = req.body;
    
    // Простая проверка подключения к прокси
    // В реальном приложении здесь можно использовать библиотеку для работы с прокси
    // Например, через HTTP запрос через прокси
    const testUrl = 'https://api.mainnet-beta.solana.com';
    
    // Здесь можно реализовать реальное тестирование прокси
    // Пока просто проверяем, что параметры валидны
    if (!host || !port) {
      return res.json({ success: false, error: 'Host and port are required' });
    }

    // Базовая валидация
    const proxyUrl = username && password
      ? `${type}://${username}:${password}@${host}:${port}`
      : `${type}://${host}:${port}`;

    // В реальном приложении здесь нужно использовать прокси для запроса
    // Пока возвращаем успех если параметры валидны
    res.json({ success: true, proxyUrl: proxyUrl.replace(/\/\/.*:.*@/, '//***:***@') });
  } catch (error) {
    console.error('Error testing proxy:', error);
    res.status(500).json({ success: false, error: 'Failed to test proxy' });
  }
});

// RPC settings endpoints removed: RPC is fixed and not configurable via web

// Главная страница
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ================== Jupiter v6 API ==================
// Получение котировки
app.post('/api/jup/quote', async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps, onlyDirectRoutes, dexes } = req.body || {};
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: 'inputMint, outputMint и amount обязательны' });
    }

    const quote = await jupGetQuote({
      inputMint,
      outputMint,
      amount: Number(amount),
      slippageBps: Number(slippageBps) || 100, // 1%
      onlyDirectRoutes: !!onlyDirectRoutes,
      dexes: Array.isArray(dexes) && dexes.length ? dexes : undefined,
    } as any);

    res.json(quote);
  } catch (error) {
    console.error('Error getting Jupiter quote:', error);
    res.status(500).json({ error: (error as Error).message || 'Quote failed' });
  }
});

// Генерация swap-транзакции для подписи кошельком пользователя
app.post('/api/jup/swap-tx', async (req, res) => {
  try {
    const { userPublicKey, quoteResponse, asLegacyTransaction } = req.body || {};
    if (!userPublicKey || !quoteResponse) {
      return res.status(400).json({ error: 'userPublicKey и quoteResponse обязательны' });
    }

    const connection = getConnection();
    const userPk = new PublicKey(String(userPublicKey));

    const tx = await jupCreateSwapTx(connection, userPk, quoteResponse, !!asLegacyTransaction);

    // Возвращаем сериализованную транзакцию base64 для подписи Phantom
    const serialized = Buffer.from(tx.serialize()).toString('base64');
    res.json({ swapTransaction: serialized });
  } catch (error) {
    console.error('Error creating Jupiter swap tx:', error);
    res.status(500).json({ error: (error as Error).message || 'Create swap tx failed' });
  }
});
// ====================================================

// Отправка подписанной транзакции через наш RPC (Helius)
app.post('/api/tx/send', async (req, res) => {
  try {
    const { signedTxBase64 } = req.body || {};
    if (!signedTxBase64) {
      return res.status(400).json({ error: 'signedTxBase64 обязателен' });
    }
    const connection = getConnection();
    const raw = Buffer.from(String(signedTxBase64), 'base64');
    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });
    res.json({ signature: sig });
  } catch (error) {
    console.error('Error sending raw transaction:', error);
    res.status(500).json({ error: (error as Error).message || 'Send failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});

