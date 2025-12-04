import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Connection, PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import fs from 'fs';
import { getConnection } from './rpc.js';
import { getQuote as jupGetQuote, createSwapTransaction as jupCreateSwapTx } from './dex/jupiter.js';
import { getTokenDecimals } from './utils/tokenUtils.js';
import { createOpenPositionTransaction, createClosePositionTransaction, previewPositionAmounts, createDlmmPool, getActualPositionAmounts } from './dex/meteora.js';
import { CONFIG } from './config.js';
import { loadAdminConfig, saveAdminConfig, getPoolConfig, savePoolConfig, getPoolConfigOrDefault, getAllPoolConfigs, type AdminConfig, type PoolConfig } from './position-monitoring/config.js';
import { PositionStorage } from './position-monitoring/storage.js';
import type { PositionInfo } from './position-monitoring/types.js';

type TokenInfo = {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  logoURI?: string;
  tags?: string[];
  verified?: boolean;
};

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

// Кэш для списка токенов (обновляется не чаще раза в час)
const TOKEN_CACHE_TTL = 60 * 60 * 1000;
let cachedTokens: { data: TokenInfo[]; fetchedAt: number } | null = null;

// Кэш для цен токенов (обновляется каждые 30 секунд)
const PRICE_CACHE_TTL = 30 * 1000;
const priceCache = new Map<string, { price: number; fetchedAt: number }>();

// Отслеживание ошибок для предотвращения спама в логах
const errorLogCache = new Map<string, number>();
const ERROR_LOG_THROTTLE = 60 * 1000; // Логировать ошибку для токена не чаще раза в минуту

function buildJupiterHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (CONFIG.jup.apiKey) {
    headers['x-api-key'] = CONFIG.jup.apiKey;
  }
  return headers;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: buildJupiterHeaders() });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status}): ${url}`);
  }
  return res.json() as Promise<T>;
}

function normalizeToken(entry: any): TokenInfo | null {
  if (!entry || typeof entry !== 'object') return null;
  const address = typeof entry.id === 'string' ? entry.id : typeof entry.address === 'string' ? entry.address : null;
  if (!address) return null;
  const symbol = typeof entry.symbol === 'string' ? entry.symbol.toUpperCase() : undefined;
  const name = typeof entry.name === 'string' ? entry.name : undefined;
  const decimals = typeof entry.decimals === 'number' ? entry.decimals : undefined;
  const logoURI =
    (typeof entry.icon === 'string' && entry.icon) ||
    (typeof entry.logoURI === 'string' && entry.logoURI) ||
    (typeof entry.logo === 'string' && entry.logo) ||
    undefined;
  const tags = Array.isArray(entry.tags) ? entry.tags.map(String) : undefined;
  const verified = typeof entry.isVerified === 'boolean' ? entry.isVerified : tags?.includes('verified');
  return {
    address,
    symbol,
    name,
    decimals,
    logoURI,
    tags,
    verified,
  };
}

async function loadTokensFromJupiter(): Promise<TokenInfo[]> {
  const base = CONFIG.jup.tokensBase;
  const sources: Array<{ path: string; params?: Record<string, string> }> = [
    { path: '/toporganicscore/24h', params: { limit: '100' } },
    { path: '/toptraded/24h', params: { limit: '100' } },
    { path: '/toptrending/24h', params: { limit: '100' } },
    { path: '/recent', params: { limit: '100' } },
  ];

  const results = await Promise.allSettled(
    sources.map(async source => {
      const url = new URL(base + source.path);
      if (source.params) {
        Object.entries(source.params).forEach(([key, value]) => url.searchParams.set(key, value));
      }
      return fetchJson<any[]>(url.toString());
    }),
  );

  const tokensMap = new Map<string, TokenInfo>();
  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      for (const entry of result.value) {
        const token = normalizeToken(entry);
        if (token?.address && !tokensMap.has(token.address)) {
          tokensMap.set(token.address, token);
        }
      }
    }
  }

  if (tokensMap.size === 0) {
    throw new Error('Failed to load tokens from Jupiter tokens API');
  }

  return Array.from(tokensMap.values());
}

async function loadFallbackTokenList(): Promise<TokenInfo[]> {
  const fallbackUrl = 'https://raw.githubusercontent.com/solana-labs/token-list/master/src/tokens/solana.tokenlist.json';
  const fallbackResponse = await fetch(fallbackUrl);
  if (!fallbackResponse.ok) {
    throw new Error(`Fallback token list returned status ${fallbackResponse.status}`);
  }
  const fallbackData = await fallbackResponse.json();
  const list = Array.isArray(fallbackData?.tokens) ? fallbackData.tokens : [];
  return list
    .map(normalizeToken)

    .filter((token: TokenInfo | null): token is TokenInfo => !!token)
    .slice(0, 5000); // cap to keep payload reasonable
}

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

// API endpoint для списка токенов (используется автопоиском на фронтенде)
app.get('/api/tokens', async (_req, res) => {
  try {
    const now = Date.now();
    if (cachedTokens && now - cachedTokens.fetchedAt < TOKEN_CACHE_TTL) {
      return res.json(cachedTokens.data);
    }

    let tokens: TokenInfo[] = [];
    try {
      tokens = await loadTokensFromJupiter();
      console.log(`Loaded ${tokens.length} tokens from Jupiter Tokens API`);
    } catch (primaryError) {
      console.warn('Failed to load tokens from Jupiter API, falling back to public list:', primaryError);
      tokens = await loadFallbackTokenList();
      console.log(`Loaded ${tokens.length} tokens from fallback list`);
    }

    cachedTokens = { data: tokens, fetchedAt: now };
    res.json(tokens);
  } catch (error) {
    console.error('Error fetching token list:', error);
    if (cachedTokens) {
      console.log('Serving token list from stale cache due to error');
      return res.json(cachedTokens.data);
    }
    res.status(500).json({ error: 'Failed to load token list' });
  }
});

app.get('/api/tokens/search', async (req, res) => {
  try {
    const query = String(req.query.q ?? req.query.query ?? '').trim();
    if (!query) {
      return res.status(400).json({ error: 'query parameter is required' });
    }
    const url = new URL(`${CONFIG.jup.tokensBase}/search`);
    url.searchParams.set('query', query);
    const results = await fetchJson<any[]>(url.toString());
    const mapped = Array.isArray(results)
      ? results
          .map(normalizeToken)
          .filter((token): token is TokenInfo => !!token)
          .slice(0, 50)
      : [];
    res.json(mapped);
  } catch (error) {
    console.error('Error searching tokens:', error);
    res.status(500).json({ error: 'Failed to search tokens' });
  }
});

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

// API endpoint для получения пулов по паре токенов
app.get('/api/pools/by-pair', async (req, res) => {
  try {
    const { tokenXMint, tokenYMint } = req.query;
    
    if (!tokenXMint || !tokenYMint) {
      return res.status(400).json({ error: 'tokenXMint и tokenYMint обязательны' });
    }

    // Получаем все пулы
    const response = await fetch('https://dlmm-api.meteora.ag/pair/all');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const allPools = await response.json();
    
    // Фильтруем пулы по паре токенов (учитываем обе возможные комбинации)
    const filteredPools = allPools.filter((pool: any) => {
      const poolTokenXMint = pool.tokenXMint || pool.token_x?.mint || pool.base_mint || '';
      const poolTokenYMint = pool.tokenYMint || pool.token_y?.mint || pool.quote_mint || '';
      
      // Проверяем обе комбинации (X/Y и Y/X)
      const match1 = poolTokenXMint === tokenXMint && poolTokenYMint === tokenYMint;
      const match2 = poolTokenXMint === tokenYMint && poolTokenYMint === tokenXMint;
      return match1 || match2;
    });
    
    res.json(filteredPools);
  } catch (error) {
    console.error('Error fetching pools by pair:', error);
    res.status(500).json({ error: 'Failed to fetch pools by pair' });
  }
});

// API endpoint для получения decimals токена из блокчейна (для новых токенов)
app.get('/api/tokens/:mintAddress/decimals', async (req, res) => {
  try {
    const { mintAddress } = req.params;
    
    if (!mintAddress) {
      return res.status(400).json({ error: 'mintAddress обязателен' });
    }
    
    const connection = getConnection();
    const decimals = await getTokenDecimals(connection, mintAddress);
    
    res.json({ mintAddress, decimals });
  } catch (error) {
    console.error(`Error getting decimals for ${req.params.mintAddress}:`, error);
    res.status(500).json({ error: `Failed to get decimals: ${(error as Error).message}` });
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
    
    // Если activeBin отсутствует в API ответе, получаем его через SDK
    if (!poolData.active_bin && !poolData.activeBin && !poolData.activeBinId) {
      try {
        const { createDlmmPool } = await import('./dex/meteora.js');
        const connection = getConnection();
        const dlmmPool = await createDlmmPool(connection, address);
        const activeBin = await dlmmPool.getActiveBin();
        poolData.active_bin = activeBin.binId;
        poolData.activeBin = activeBin.binId;
        poolData.activeBinId = activeBin.binId;
      } catch (sdkError) {
        console.warn(`Could not get activeBin from SDK for pool ${address}:`, sdkError);
        // Продолжаем без activeBin
      }
    }

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
    const message = (error as Error).message || 'Quote failed';
    if (message.includes('ENOTFOUND') || message.includes('EAI_AGAIN')) {
      return res.status(502).json({
        error: 'DNS_ERROR: Не удалось разрешить lite-api.jup.ag. Проверьте DNS/VPN или задайте JUP_SWAP_BASE в .env на доступный прокси.',
      });
    }
    res.status(500).json({ error: message });
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
    const { signedTxBase64, waitForConfirmation } = req.body || {};
    if (!signedTxBase64) {
      return res.status(400).json({ error: 'signedTxBase64 обязателен' });
    }
    const connection = getConnection();
    const raw = Buffer.from(String(signedTxBase64), 'base64');
    
    // Получаем blockhash для проверки подтверждения
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    
    // Проверяем актуальность blockhash в транзакции перед отправкой
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(raw);
    } catch (e) {
      return res.status(400).json({ error: 'Не удалось десериализовать транзакцию' });
    }
    
    const txBlockhash = tx.message.recentBlockhash;
    const currentBlockhashInfo = await connection.getLatestBlockhash('confirmed');
    const blockhashAge = currentBlockhashInfo.lastValidBlockHeight - (tx.message as any).lastValidBlockHeight || 0;
    
    // Если blockhash устарел (больше 150 слотов = ~60 секунд), отклоняем транзакцию
    if (txBlockhash && txBlockhash !== currentBlockhashInfo.blockhash) {
      console.warn(`[SERVER] ⚠️ Blockhash in transaction is outdated: ${txBlockhash.substring(0, 8)}... (current: ${currentBlockhashInfo.blockhash.substring(0, 8)}...)`);
      
      // Проверяем, не слишком ли старый blockhash
      if (blockhashAge > 150) {
        return res.status(400).json({
          error: 'Blockhash устарел. Пожалуйста, пересоздайте транзакцию.',
          code: 'BLOCKHASH_EXPIRED',
          hint: 'Транзакция была создана слишком давно. Создайте новую транзакцию и подпишите её быстрее.',
          blockhashAge,
        });
      }
    }
    
    let sig: string;
    try {
      console.log(`[SERVER] 📤 Sending transaction with blockhash: ${txBlockhash?.substring(0, 8) || 'none'}...`);
      // Отправляем транзакцию - Solana сеть сама проверит blockhash
      // Если blockhash устарел, сеть вернет ошибку, которую мы обработаем
      sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
        maxRetries: 3,
      });
      console.log(`[SERVER] ✅ Transaction sent successfully: ${sig.substring(0, 8)}...`);
    } catch (sendError: any) {
      console.error(`[SERVER] ❌ Error sending transaction:`, sendError);
      // Обрабатываем ошибки отправки транзакции
      if (sendError.message?.includes('Blockhash not found') || 
          sendError.message?.includes('blockhash') ||
          sendError.transactionMessage?.includes('Blockhash not found')) {
        return res.status(400).json({
          error: 'Blockhash устарел. Пожалуйста, пересоздайте транзакцию.',
          code: 'BLOCKHASH_EXPIRED',
          hint: 'Транзакция была создана слишком давно. Создайте новую транзакцию и подпишите её быстрее.',
        });
      }
      throw sendError; // Пробрасываем другие ошибки дальше
    }
    
    // Если требуется подтверждение, ждем его с таймаутом
    if (waitForConfirmation !== false) {
      try {
        // Добавляем таймаут для подтверждения транзакции (60 секунд)
        const CONFIRMATION_TIMEOUT = 60000; // 60 секунд
        
        const confirmationPromise = connection.confirmTransaction(
          {
            signature: sig,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          },
          'confirmed',
        );
        
        // Создаем промис с таймаутом
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Таймаут подтверждения транзакции. Транзакция может быть еще в процессе подтверждения.'));
          }, CONFIRMATION_TIMEOUT);
        });
        
        // Ждем либо подтверждения, либо таймаута
        const confirmation = await Promise.race([confirmationPromise, timeoutPromise]) as any;
        
        if (confirmation.value.err) {
          return res.status(500).json({
            error: `Транзакция отклонена: ${JSON.stringify(confirmation.value.err)}`,
            signature: sig,
          });
        }
        
        return res.json({
          signature: sig,
          confirmed: true,
        });
      } catch (confirmError: any) {
        // Обрабатываем таймаут
        if (confirmError.message?.includes('Таймаут')) {
          console.warn(`[SERVER] ⚠️ Confirmation timeout for transaction ${sig.substring(0, 8)}...`);
          return res.status(408).json({
            error: 'Таймаут подтверждения транзакции. Транзакция может быть еще в процессе подтверждения. Проверьте статус транзакции в Solscan.',
            signature: sig,
            timeout: true,
            hint: `Проверьте транзакцию: https://solscan.io/tx/${sig}`,
          });
        }
        
        // Обрабатываем таймаут
        if (confirmError.message?.includes('Таймаут')) {
          console.warn(`[SERVER] ⚠️ Confirmation timeout for transaction ${sig.substring(0, 8)}...`);
          return res.status(408).json({
            error: 'Таймаут подтверждения транзакции (60 секунд). Транзакция может быть еще в процессе подтверждения. Проверьте статус в Solscan.',
            signature: sig,
            timeout: true,
            hint: `Проверьте транзакцию: https://solscan.io/tx/${sig}`,
          });
        }
        
        // Обрабатываем ошибку истечения транзакции
        if (confirmError.name === 'TransactionExpiredBlockheightExceededError' || 
            confirmError.message?.includes('expired') ||
            confirmError.message?.includes('block height exceeded')) {
          console.warn(`[SERVER] ⚠️ Transaction expired: ${sig.substring(0, 8)}...`);
          return res.status(408).json({
            error: 'Транзакция истекла. Пожалуйста, создайте новую транзакцию. Транзакции в Solana действительны только около 60-90 секунд.',
            signature: sig,
            expired: true,
            hint: 'Попробуйте создать транзакцию заново и подписать её быстрее.',
          });
        }
        
        // Другие ошибки подтверждения
        console.error('Error confirming transaction:', confirmError);
        return res.status(500).json({
          error: `Ошибка подтверждения транзакции: ${confirmError.message || 'Unknown error'}`,
          signature: sig,
          confirmed: false,
        });
      }
    }
    
    return res.json({
      signature: sig,
      confirmed: waitForConfirmation === false ? undefined : false,
    });
  } catch (error) {
    console.error('Error sending transaction:', error);
    return res.status(500).json({ 
      error: (error as Error).message || 'Transaction failed',
    });
  }
});

// ================== Meteora DLMM Position API ==================
// Генерация транзакции открытия позиции в пуле
app.post('/api/meteora/open-position-tx', async (req, res) => {
  try {
    const { poolAddress, userPublicKey, strategy, rangeInterval, tokenXAmount, tokenYAmount } = req.body || {};
    
    // Валидация входных параметров
    if (!poolAddress || !userPublicKey || !strategy || rangeInterval === undefined || !tokenXAmount || tokenYAmount === undefined) {
      return res.status(400).json({ error: 'Все параметры обязательны: poolAddress, userPublicKey, strategy, rangeInterval, tokenXAmount, tokenYAmount' });
    }
    
    if (!['balance', 'imbalance', 'oneSide'].includes(strategy)) {
      return res.status(400).json({ error: 'Некорректная стратегия. Допустимые значения: balance, imbalance, oneSide' });
    }
    
    if (rangeInterval < 1 || rangeInterval > 100) {
      return res.status(400).json({ error: 'Диапазон должен быть от 1 до 100' });
    }
    
    if (parseFloat(tokenXAmount) <= 0) {
      return res.status(400).json({ error: 'Количество Token X должно быть больше 0' });
    }
    
    // Для oneSide стратегии tokenYAmount может быть 0
    if (strategy !== 'oneSide' && parseFloat(tokenYAmount) <= 0) {
      return res.status(400).json({ error: 'Количество Token Y должно быть больше 0 для выбранной стратегии' });
    }
    
    // Валидация адреса пула
    try {
      new PublicKey(String(poolAddress));
    } catch (e) {
      return res.status(400).json({ error: 'Некорректный адрес пула' });
    }
    
    // Валидация адреса пользователя
    try {
      new PublicKey(String(userPublicKey));
    } catch (e) {
      return res.status(400).json({ error: 'Некорректный адрес пользователя' });
    }

    const connection = getConnection();
    const userPk = new PublicKey(String(userPublicKey));

    let { transaction, positionKeypair } = await createOpenPositionTransaction(connection, {
      poolAddress: String(poolAddress),
      userPublicKey: userPk,
      strategy: strategy as 'balance' | 'imbalance' | 'oneSide',
      rangeInterval: Number(rangeInterval),
      tokenXAmount: String(tokenXAmount),
      tokenYAmount: String(tokenYAmount),
    });

    // ВСЕГДА обновляем blockhash в транзакции перед отправкой на клиент
    // Это гарантирует, что транзакция будет актуальной при подписи
    // Получаем самый свежий blockhash прямо перед отправкой
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    const currentBlockhash = transaction.message.recentBlockhash;
    
    // Проверяем, действительно ли blockhash изменился
    const blockhashChanged = !currentBlockhash || currentBlockhash !== latestBlockhash.blockhash;
    
    if (blockhashChanged) {
      console.log(`[SERVER] Updating transaction blockhash before sending to client: ${currentBlockhash?.substring(0, 8) || 'none'}... -> ${latestBlockhash.blockhash.substring(0, 8)}...`);
    } else {
      console.log(`[SERVER] Transaction blockhash is already up-to-date: ${currentBlockhash.substring(0, 8)}...`);
    }
    
    // ВСЕГДА пересоздаем транзакцию с актуальным blockhash для надежности
    // Даже если blockhash кажется актуальным, он мог устареть за время создания транзакции
    const message = transaction.message;
    
    const updatedMessage = new TransactionMessage({
      payerKey: message.staticAccountKeys[0],
      recentBlockhash: latestBlockhash.blockhash,
      instructions: message.compiledInstructions.map(ix => {
        const programId = message.staticAccountKeys[ix.programIdIndex];
        
        const numWritableSigners = message.header.numRequiredSignatures - message.header.numReadonlySignedAccounts;
        const numWritableNonSigners = message.staticAccountKeys.length - message.header.numRequiredSignatures - message.header.numReadonlyUnsignedAccounts;
        
        const accounts = ix.accountKeyIndexes.map(idx => {
          const pubkey = message.staticAccountKeys[idx];
          const isSigner = idx < message.header.numRequiredSignatures;
          const isWritable = isSigner 
            ? idx < numWritableSigners
            : idx < message.header.numRequiredSignatures + numWritableNonSigners;
          
          return { pubkey, isSigner, isWritable };
        });
        
        return {
          programId,
          keys: accounts,
          data: Buffer.from(ix.data),
        };
      }),
    });
    
    transaction = new VersionedTransaction(updatedMessage.compileToV0Message());
    
    // Проверяем, что blockhash действительно обновился в транзакции
    const finalBlockhash = transaction.message.recentBlockhash;
    if (finalBlockhash !== latestBlockhash.blockhash) {
      console.error(`[SERVER] ⚠️ WARNING: Blockhash update failed! Expected: ${latestBlockhash.blockhash.substring(0, 8)}..., Got: ${finalBlockhash?.substring(0, 8) || 'none'}...`);
      throw new Error('Failed to update transaction blockhash');
    }
    
    if (blockhashChanged) {
      console.log(`[SERVER] ✅ Blockhash successfully updated: ${finalBlockhash.substring(0, 8)}...`);
    } else {
      console.log(`[SERVER] ✅ Blockhash verified (no update needed): ${finalBlockhash.substring(0, 8)}...`);
    }

    // Сериализуем транзакцию в base64
    const serialized = Buffer.from(transaction.serialize()).toString('base64');
    
    // Возвращаем транзакцию и публичный ключ позиции (для подписи position keypair)
    res.json({
      transaction: serialized,
      positionPublicKey: positionKeypair.publicKey.toBase58(),
      positionSecretKey: Array.from(positionKeypair.secretKey), // для подписи на сервере или клиенте
    });
  } catch (error) {
    console.error('Error creating open position tx:', error);
    res.status(500).json({ error: (error as Error).message || 'Create open position tx failed' });
  }
});
// ====================================================

// Предварительный расчет реальных сумм для открытия позиции
app.post('/api/meteora/preview-position-amounts', async (req, res) => {
  try {
    const { poolAddress, strategy, rangeInterval, tokenXAmount, tokenYAmount } = req.body || {};
    
    // Валидация входных параметров
    if (!poolAddress || !strategy || rangeInterval === undefined || !tokenXAmount || tokenYAmount === undefined) {
      return res.status(400).json({ error: 'Все параметры обязательны: poolAddress, strategy, rangeInterval, tokenXAmount, tokenYAmount' });
    }
    
    if (!['balance', 'imbalance', 'oneSide'].includes(strategy)) {
      return res.status(400).json({ error: 'Некорректная стратегия. Допустимые значения: balance, imbalance, oneSide' });
    }
    
    if (rangeInterval < 1 || rangeInterval > 100) {
      return res.status(400).json({ error: 'Диапазон должен быть от 1 до 100' });
    }
    
    if (parseFloat(tokenXAmount) <= 0) {
      return res.status(400).json({ error: 'Количество Token X должно быть больше 0' });
    }
    
    // Валидация адреса пула
    try {
      new PublicKey(String(poolAddress));
    } catch (e) {
      return res.status(400).json({ error: 'Некорректный адрес пула' });
    }

    const connection = getConnection();

    const preview = await previewPositionAmounts(connection, {
      poolAddress: String(poolAddress),
      strategy: strategy as 'balance' | 'imbalance' | 'oneSide',
      rangeInterval: Number(rangeInterval),
      tokenXAmount: String(tokenXAmount),
      tokenYAmount: String(tokenYAmount),
    });

    res.json(preview);
  } catch (error) {
    console.error('Error previewing position amounts:', error);
    res.status(500).json({ error: (error as Error).message || 'Preview position amounts failed' });
  }
});

// Получение реальных сумм из позиции после её создания
app.post('/api/meteora/actual-position-amounts', async (req, res) => {
  try {
    const { poolAddress, positionAddress, userPublicKey } = req.body || {};
    
    // Валидация входных параметров
    if (!poolAddress || !positionAddress || !userPublicKey) {
      return res.status(400).json({ error: 'Все параметры обязательны: poolAddress, positionAddress, userPublicKey' });
    }
    
    // Валидация адресов
    try {
      new PublicKey(String(poolAddress));
      new PublicKey(String(positionAddress));
      new PublicKey(String(userPublicKey));
    } catch (e) {
      return res.status(400).json({ error: 'Некорректный адрес' });
    }

    const connection = getConnection();
    const userPubKey = new PublicKey(userPublicKey);

    const actualAmounts = await getActualPositionAmounts(
      connection,
      String(poolAddress),
      String(positionAddress),
      userPubKey,
    );

    res.json(actualAmounts);
  } catch (error) {
    console.error('Error getting actual position amounts:', error);
    res.status(500).json({ error: (error as Error).message || 'Get actual position amounts failed' });
  }
});

// ================== Position API ==================
// Сохранить позицию после открытия
app.post('/api/positions/save', async (req, res) => {
  try {
    const {
      positionAddress,
      poolAddress,
      userAddress,
      strategy,
      rangeInterval,
      tokenXAmount,
      tokenYAmount,
      tokenXMint: reqTokenXMint,
      tokenYMint: reqTokenYMint,
    } = req.body || {};
    
    console.log(`[WEB] 📨 Received position save request:`, {
      positionAddress: positionAddress?.substring(0, 8) + '...' || 'N/A',
      tokenXAmount: tokenXAmount || 'MISSING',
      tokenYAmount: tokenYAmount || 'MISSING',
      strategy,
      rangeInterval,
    });
    
    if (!positionAddress || !poolAddress || !userAddress) {
      return res.status(400).json({ error: 'positionAddress, poolAddress и userAddress обязательны' });
    }
    
    const connection = getConnection();
    const storage = new PositionStorage();
    
    // Получаем активный bin для расчета min/max bin IDs и границ
    // Без fallback - если не удается получить, выбрасываем ошибку
    const dlmmPool = await createDlmmPool(connection, poolAddress);
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;
    const binStep = (dlmmPool.lbPair as any).binStep;
    // Используем mint-адреса из пула (более надежно, чем из req.body)
    const tokenXMint = (dlmmPool.lbPair as any).tokenXMint.toBase58();
    const tokenYMint = (dlmmPool.lbPair as any).tokenYMint.toBase58();
    
    let minBinId: number;
    let maxBinId: number;
    
    if (strategy === 'oneSide') {
      minBinId = activeBinId;
      maxBinId = activeBinId + rangeInterval * 2;
    } else {
      minBinId = activeBinId - rangeInterval;
      maxBinId = activeBinId + rangeInterval;
    }
    
    // Получаем текущую цену для конвертации границ в доллары
    const { PriceMonitor } = await import('./position-monitoring/priceMonitor.js');
    const priceMonitor = new PriceMonitor(connection);
    const currentPriceUSD = await priceMonitor.getPoolPrice(poolAddress);
    
    // Рассчитываем границы на основе бинов в долларах
    const bounds = await priceMonitor.calculateBoundsFromBinsUSD(
      minBinId, 
      maxBinId, 
      binStep,
      tokenYMint,
      currentPriceUSD,
      poolAddress // Передаем poolAddress для правильного расчета границ
    );
    const upperBoundPrice = bounds.upperBoundPrice;
    const lowerBoundPrice = bounds.lowerBoundPrice;
    
    const position: PositionInfo = {
      positionAddress,
      poolAddress,
      userAddress,
      tokenXMint: tokenXMint,
      tokenYMint: tokenYMint,
      initialTokenXAmount: tokenXAmount || '0',
      initialTokenYAmount: tokenYAmount || '0',
      initialPrice: currentPriceUSD,
      upperBoundPrice,
      lowerBoundPrice,
      minBinId,
      maxBinId,
      rangeInterval, // Сохраняем rangeInterval для будущего использования
      status: 'active',
      openedAt: Date.now(),
      lastPriceCheck: Date.now(),
      currentPrice: currentPriceUSD,
      accumulatedFees: 0,
    };
    
    console.log(`[WEB] 💾 Сохраняем позицию ${positionAddress.substring(0, 8)}...`, {
      poolAddress: poolAddress.substring(0, 8) + '...',
      userAddress: userAddress.substring(0, 8) + '...',
      strategy,
      rangeInterval,
      tokenXAmount,
      tokenYAmount,
      currentPrice: currentPriceUSD.toFixed(2),
      lowerBound: lowerBoundPrice.toFixed(2),
      upperBound: upperBoundPrice.toFixed(2),
      minBinId,
      maxBinId,
    });
    
    storage.savePosition(position);
    
    console.log(`[WEB] ✅ Позиция ${positionAddress.substring(0, 8)}... успешно сохранена в базу данных`);
    
    res.json({ success: true, position });
  } catch (error) {
    console.error('Error saving position:', error);
    res.status(500).json({ error: (error as Error).message || 'Failed to save position' });
  }
});

// Получить позиции пользователя (с проверкой существования на блокчейне)
app.get('/api/positions', async (req, res) => {
  try {
    const { userAddress, verify = 'true' } = req.query;
    const storage = new PositionStorage();
    
    let positions = storage.loadPositions();
    
    // Фильтруем по адресу пользователя и ТОЛЬКО активные позиции
    if (userAddress) {
      positions = positions.filter(p => p.userAddress === String(userAddress));
    }
    
    // ПОКАЗЫВАЕМ ТОЛЬКО АКТИВНЫЕ позиции
    positions = positions.filter(p => p.status === 'active');
    
    // Проверяем существование активных позиций на блокчейне
    if (verify === 'true' && positions.length > 0) {
      const connection = getConnection();
      const verifiedPositions: PositionInfo[] = [];
      let removedCount = 0;
      
      await Promise.all(positions.map(async (position) => {
        try {
          const { getPositionInfo } = await import('./dex/meteora.js');
          await getPositionInfo(
            connection,
            position.poolAddress,
            position.positionAddress,
            new PublicKey(position.userAddress),
          );
          // Позиция существует на блокчейне - включаем её
          verifiedPositions.push(position);
        } catch (error) {
          // Позиция не найдена на блокчейне - помечаем как закрытую
          console.warn(`⚠️ Phantom position detected: ${position.positionAddress.substring(0, 8)}... (not found on blockchain)`);
          position.status = 'closed';
          position.closedAt = Date.now();
          storage.savePosition(position);
          removedCount++;
        }
      }));
      
      positions = verifiedPositions;
      
      if (removedCount > 0) {
        console.log(`🗑️ Removed ${removedCount} phantom position(s) - они не существуют на блокчейне`);
      }
    }
    
    // Сортируем по дате открытия (новые сначала)
    positions.sort((a, b) => b.openedAt - a.openedAt);
    
    res.json(positions);
  } catch (error) {
    console.error('Error loading positions:', error);
    res.status(500).json({ error: 'Failed to load positions' });
  }
});

// Получить статистику по позициям пользователя
app.get('/api/positions/stats', async (req, res) => {
  try {
    const { userAddress } = req.query;
    if (!userAddress) {
      return res.status(400).json({ error: 'userAddress обязателен' });
    }
    
    const storage = new PositionStorage();
    const allPositions = storage.loadPositions();
    
    // Фильтруем по адресу пользователя
    const userPositions = allPositions.filter(p => p.userAddress === String(userAddress));
    
    // Подсчитываем статистику
    const activePositions = userPositions.filter(p => p.status === 'active');
    const closedPositions = userPositions.filter(p => p.status === 'closed');
    
    // Суммируем накопленные комиссии из всех позиций (активных и закрытых)
    const totalFees = userPositions.reduce((sum, position) => {
      const fees = position.accumulatedFees || 0;
      return sum + fees;
    }, 0);
    
    res.json({
      activePositionsCount: activePositions.length,
      closedPositionsCount: closedPositions.length,
      totalFees: totalFees,
    });
  } catch (error) {
    console.error('Error loading positions stats:', error);
    res.status(500).json({ error: 'Failed to load positions stats' });
  }
});

// Получить конкретную позицию
app.get('/api/positions/:positionAddress', (req, res) => {
  try {
    const { positionAddress } = req.params;
    const storage = new PositionStorage();
    
    const position = storage.getPosition(positionAddress);
    
    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }
    
    res.json(position);
  } catch (error) {
    console.error('Error loading position:', error);
    res.status(500).json({ error: 'Failed to load position' });
  }
});

// Получить расширенную информацию о позиции (стоимость в USD, P&L, ROI)
app.get('/api/positions/:positionAddress/details', async (req, res) => {
  try {
    const { positionAddress } = req.params;
    const storage = new PositionStorage();
    
    const position = storage.getPosition(positionAddress);
    
    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }

    // Получаем цены токенов в USD через Jupiter Price API
    const getTokenPriceUSD = async (mintAddress: string, retries = 2): Promise<number> => {
      // Проверяем кэш
      const cached = priceCache.get(mintAddress);
      if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL) {
        return cached.price;
      }

      try {
        // Если это SOL, используем прямой запрос
        if (mintAddress === 'So11111111111111111111111111111111111111112') {
          const url = `${CONFIG.jup.priceEndpoint}/price?ids=${mintAddress}`;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);
          
          try {
            const response = await fetch(url, { 
              headers: buildJupiterHeaders(),
              signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
              const errorText = await response.text().catch(() => 'Unknown error');
              throw new Error(`Failed to fetch SOL price: ${response.status} ${response.statusText} - ${errorText}`);
            }
            
            const data = await response.json();
            const price = data.data?.[mintAddress]?.price || 0;
            
            // Сохраняем в кэш
            if (price > 0) {
              priceCache.set(mintAddress, { price, fetchedAt: Date.now() });
            }
            
            return price;
          } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError instanceof Error && fetchError.name === 'AbortError') {
              throw new Error('Request timeout');
            }
            throw fetchError;
          }
        }

        // Для других токенов, получаем цену относительно USDC
        const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const url = `${CONFIG.jup.priceEndpoint}/price?ids=${mintAddress}&vsToken=${usdcMint}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        try {
          const response = await fetch(url, { 
            headers: buildJupiterHeaders(),
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            // Retry для временных ошибок
            if (retries > 0 && (response.status === 429 || response.status >= 500)) {
              await new Promise(resolve => setTimeout(resolve, 1000)); // Задержка 1 секунда
              return getTokenPriceUSD(mintAddress, retries - 1);
            }
            
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Failed to fetch token price: ${response.status} ${response.statusText} - ${errorText}`);
          }
          
          const data = await response.json();
          const priceData = data.data?.[mintAddress];
          
          if (!priceData) {
            // Токен не найден - это нормально для новых/редких токенов
            return 0;
          }
          
          let price = 0;
          
          // Если цена уже в USD (vs USDC), возвращаем её
          if (priceData.vsToken === usdcMint) {
            price = priceData.price || 0;
          } else {
            // Иначе получаем цену через SOL
            const solPrice = await getTokenPriceUSD('So11111111111111111111111111111111111111112', retries);
            price = (priceData.price || 0) * solPrice;
          }
          
          // Сохраняем в кэш только если цена валидна
          if (price > 0) {
            priceCache.set(mintAddress, { price, fetchedAt: Date.now() });
          }
          
          return price;
        } catch (fetchError) {
          clearTimeout(timeoutId);
          if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            throw new Error('Request timeout');
          }
          throw fetchError;
        }
      } catch (error) {
        // Логируем ошибку только если не логировали недавно для этого токена
        const lastLogTime = errorLogCache.get(mintAddress) || 0;
        const now = Date.now();
        
        if (now - lastLogTime > ERROR_LOG_THROTTLE) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`Error getting price for token ${mintAddress.substring(0, 8)}...: ${errorMessage}`);
          errorLogCache.set(mintAddress, now);
        }
        
        // Возвращаем кэшированное значение если есть (даже если устаревшее)
        if (cached) {
          return cached.price;
        }
        
        return 0;
      }
    };

    // Получаем decimals токенов и mint-адреса
    const connection = getConnection();
    
    // Если mint-адреса не сохранены, получаем их из пула
    let tokenXMint = position.tokenXMint;
    let tokenYMint = position.tokenYMint;
    
    if (!tokenXMint || !tokenYMint) {
      try {
        const dlmmPool = await createDlmmPool(connection, position.poolAddress);
        tokenXMint = (dlmmPool.lbPair as any).tokenXMint.toBase58();
        tokenYMint = (dlmmPool.lbPair as any).tokenYMint.toBase58();
        
        // Обновляем позицию с mint-адресами
        position.tokenXMint = tokenXMint;
        position.tokenYMint = tokenYMint;
        const storage = new PositionStorage();
        storage.savePosition(position);
      } catch (error) {
        console.warn(`Failed to get mint addresses for pool ${position.poolAddress}:`, (error as Error).message);
      }
    }
    
    // Получаем decimals только если mint-адреса доступны
    const tokenXDecimals = tokenXMint ? await getTokenDecimals(connection, tokenXMint) : 9;
    const tokenYDecimals = tokenYMint ? await getTokenDecimals(connection, tokenYMint) : 9;

    // Пробуем получить реальные данные позиции из блокчейна
    let realTokenXAmount = 0;
    let realTokenYAmount = 0;
    let useRealData = false;
    
    try {
      const { getPositionBinData } = await import('./dex/meteora.js');
      const positionBinData = await getPositionBinData(
        connection,
        position.poolAddress,
        position.positionAddress,
        new PublicKey(position.userAddress),
      );
      
      if (positionBinData && positionBinData.length > 0) {
        // Суммируем токены из всех bins
        for (const bin of positionBinData) {
          const xAmountBN = bin.amountX || { toString: () => '0' };
          const yAmountBN = bin.amountY || { toString: () => '0' };
          
          const xAmount = typeof xAmountBN === 'object' && xAmountBN.toString
            ? parseFloat(xAmountBN.toString())
            : parseFloat(String(xAmountBN || '0'));
          const yAmount = typeof yAmountBN === 'object' && yAmountBN.toString
            ? parseFloat(yAmountBN.toString())
            : parseFloat(String(yAmountBN || '0'));
          
          realTokenXAmount += xAmount;
          realTokenYAmount += yAmount;
        }
        
        // Конвертируем из минимальных единиц в человекочитаемый формат
        realTokenXAmount = realTokenXAmount / Math.pow(10, tokenXDecimals);
        realTokenYAmount = realTokenYAmount / Math.pow(10, tokenYDecimals);
        
        // Используем реальные данные только если они не равны нулю
        // (позиция может быть только что открыта и еще не иметь ликвидности в bins)
        if (realTokenXAmount > 0 || realTokenYAmount > 0) {
          useRealData = true;
        }
      }
    } catch (error) {
      console.warn(`Failed to get real position bin data for ${position.positionAddress}:`, (error as Error).message);
    }
    
    // Получаем начальные количества токенов (для расчета начальной стоимости)
    let initialTokenXAmountHuman: number;
    let initialTokenYAmountHuman: number;
    
    const initialXNum = parseFloat(position.initialTokenXAmount);
    const initialYNum = parseFloat(position.initialTokenYAmount);
    
    // При открытии позиции через UI количества всегда сохраняются в минимальных единицах (raw format)
    // через convertToSmallestUnits(). Поэтому всегда делим на decimals.
    // Но для обратной совместимости со старыми позициями проверяем разумность результата:
    // если после деления получилось очень маленькое значение (< 1e-9) И исходное значение < 1,
    // то возможно это уже человекочитаемый формат (старая позиция, открытая до исправления)
    const initialXHuman = initialXNum / Math.pow(10, tokenXDecimals);
    const initialYHuman = initialYNum / Math.pow(10, tokenYDecimals);
    
    // Для Token X: если результат деления очень маленький (< 1e-9) и исходное значение < 1,
    // то возможно это уже человекочитаемый формат (старая позиция)
    // Но для новых позиций, открытых через UI, всегда используем результат деления
    if (initialXHuman < 1e-9 && initialXNum < 1 && initialXNum > 0 && initialXNum < 0.0001) {
      // Вероятно, это уже человекочитаемый формат (старая позиция с очень маленьким количеством)
      initialTokenXAmountHuman = initialXNum;
    } else {
      // Это минимальные единицы - используем результат деления
      initialTokenXAmountHuman = initialXHuman;
    }
    
    // Для Token Y: аналогичная проверка
    if (initialYHuman < 1e-9 && initialYNum < 1 && initialYNum > 0 && initialYNum < 0.0001) {
      // Вероятно, это уже человекочитаемый формат (старая позиция с очень маленьким количеством)
      initialTokenYAmountHuman = initialYNum;
    } else {
      // Это минимальные единицы - используем результат деления
      initialTokenYAmountHuman = initialYHuman;
    }
    
    // Получаем текущие количества токенов (для расчета текущей стоимости)
    // Приоритет: реальные данные из блокчейна (если не равны нулю) > начальные количества
    let currentTokenXAmount: number;
    let currentTokenYAmount: number;
    
    if (useRealData && (realTokenXAmount > 0 || realTokenYAmount > 0)) {
      // Используем реальные данные только если они не равны нулю
      currentTokenXAmount = realTokenXAmount;
      currentTokenYAmount = realTokenYAmount;
    } else {
      // Fallback на начальные количества, если реальные данные недоступны или равны нулю
      // (позиция может быть только что открыта и еще не иметь ликвидности в bins)
      currentTokenXAmount = initialTokenXAmountHuman;
      currentTokenYAmount = initialTokenYAmountHuman;
    }

    // Упрощенная логика: используем цену пула для расчета
    // Цена пула = цена Token X в USD (например, 141.134 = 1 SOL = $141.134)
    // Если Token Y = USDC ($1), то стоимость = Token X * цена пула + Token Y * 1

    // Получаем цену из API, если сохраненная цена выглядит неправильной (< 1 для SOL/USDC)
    let initialPoolPrice = position.initialPrice || 0;
    let currentPoolPrice = position.currentPrice || position.initialPrice || 0;
    
    // Если цена очень маленькая (< 1), возможно это цена в формате Token X/Token Y, а не в USD
    // Пробуем получить правильную цену из API
    if (initialPoolPrice > 0 && initialPoolPrice < 1) {
      try {
        const poolResponse = await fetch(`https://dlmm-api.meteora.ag/pair/${position.poolAddress}`);
        if (poolResponse.ok) {
          const poolData = await poolResponse.json();
          const apiPrice = parseFloat(poolData.price || poolData.current_price || poolData.price_usd || '0');
          if (apiPrice > 1) {
            // Используем цену из API, если она выглядит правильной
            initialPoolPrice = apiPrice;
            currentPoolPrice = apiPrice;
            // Отладочный вывод удален
          }
        }
      } catch (apiError) {
        console.warn(`Failed to get API price for pool ${position.poolAddress}:`, apiError);
      }
    }
    
    // Упрощенный расчет стоимости позиции в USD
    // Формула: Token X * цена пула (в USD) + Token Y (если Token Y = USDC = $1)
    
    // Начальная стоимость: используем начальную цену пула
    const initialValueUSD = initialTokenXAmountHuman * initialPoolPrice + initialTokenYAmountHuman * 1;
    
    // Текущая стоимость ликвидности: используем текущую цену пула
    let currentLiquidityValueUSD = currentTokenXAmount * currentPoolPrice + currentTokenYAmount * 1;
    
    // Если стоимость 0, но есть цена пула и количества - используем fallback
    if ((currentLiquidityValueUSD === 0 || isNaN(currentLiquidityValueUSD)) && currentPoolPrice > 0 && (currentTokenXAmount > 0 || currentTokenYAmount > 0)) {
      currentLiquidityValueUSD = currentTokenXAmount * currentPoolPrice + currentTokenYAmount * 1;
    }
    
    // Получаем накопленные комиссии (если не сохранены, пытаемся рассчитать)
    let accumulatedFeesUSD = position.accumulatedFees || 0;
    
    // Если комиссии не рассчитаны, пытаемся их получить/рассчитать
    if (accumulatedFeesUSD === 0 && position.status === 'active') {
      try {
        const { StrategyCalculator } = await import('./position-monitoring/strategyCalculator.js');
        const { PriceMonitor } = await import('./position-monitoring/priceMonitor.js');
        const strategyCalculator = new StrategyCalculator(new PriceMonitor(connection));
        
        const feesData = await strategyCalculator.getRealAccumulatedFeesFromAPI(
          position.poolAddress,
          position.positionAddress,
        );
        
        const timeInPoolHours = (Date.now() - position.openedAt) / (1000 * 60 * 60);
        // Упрощенная оценка: используем долю позиции в пуле
        const positionLiquidityPercent = Math.min(currentLiquidityValueUSD / (feesData.liquidity || currentLiquidityValueUSD), 1);
        
        accumulatedFeesUSD = strategyCalculator.calculateAccumulatedFees(
          position,
          feesData.poolVolume24h,
          feesData.poolFeeBps,
          positionLiquidityPercent,
          timeInPoolHours,
        );
      } catch (error) {
        console.warn(`Failed to calculate accumulated fees for position ${position.positionAddress.substring(0, 8)}...:`, (error as Error).message);
      }
    }
    
    // Текущая стоимость позиции = стоимость ликвидности + накопленные комиссии
    const currentValueUSD = currentLiquidityValueUSD + accumulatedFeesUSD;
    
    // Отладочная информация при проблемах или необычно больших значениях
    // Также выводим для новых позиций (открытых менее 5 минут назад) для диагностики
    const isNewPosition = Date.now() - position.openedAt < 5 * 60 * 1000; // 5 минут
    const hasValueIssue = (currentValueUSD === 0 || isNaN(currentValueUSD) || currentValueUSD > 10000 || initialValueUSD > 10000) && (currentTokenXAmount > 0 || currentTokenYAmount > 0);
    
    // Отладочный вывод удален
    // if (hasValueIssue || isNewPosition) { ... }

    // P&L (прибыль/убыток)
    // P&L = текущая стоимость - начальная стоимость
    // Комиссии уже включены в currentValueUSD
    const pnlUSD = currentValueUSD - initialValueUSD;
    const pnlPercent = initialValueUSD > 0 ? (pnlUSD / initialValueUSD) * 100 : 0;

    // ROI (возврат инвестиций) = P&L в процентах
    const roiPercent = pnlPercent;

    // Изменение цены
    const currentPrice = position.currentPrice || position.initialPrice;
    const priceChangePercent = position.initialPrice > 0 
      ? ((currentPrice - position.initialPrice) / position.initialPrice) * 100 
      : 0;

    // Время в позиции
    const timeInPositionMs = Date.now() - position.openedAt;
    const timeInPositionHours = timeInPositionMs / (1000 * 60 * 60);
    const timeInPositionDays = timeInPositionHours / 24;

    res.json({
      ...position,
      // Стоимость
      initialValueUSD,
      currentValueUSD,
      currentLiquidityValueUSD, // Стоимость только ликвидности (без комиссий)
      accumulatedFeesUSD, // Накопленные комиссии в USD
      // P&L
      pnlUSD,
      pnlPercent,
      // ROI
      roiPercent,
      currentTokenXAmount, // Текущее количество Token X
      currentTokenYAmount, // Текущее количество Token Y
      initialTokenXAmountHuman, // Начальное количество Token X (человекочитаемый формат)
      initialTokenYAmountHuman, // Начальное количество Token Y (человекочитаемый формат)
      // Изменение цены
      priceChangePercent,
      // Время
      timeInPositionHours,
      timeInPositionDays,
    });
  } catch (error) {
    console.error('Error loading position details:', error);
    res.status(500).json({ error: 'Failed to load position details' });
  }
});

// ================== Position Monitoring API ==================
// Получить конфигурацию админа
app.get('/api/admin/config', (req, res) => {
  try {
    const config = loadAdminConfig();
    res.json(config);
  } catch (error) {
    console.error('Error loading admin config:', error);
    res.status(500).json({ error: 'Failed to load admin config' });
  }
});

// Сохранить конфигурацию админа
app.post('/api/admin/config', (req, res) => {
  try {
    const config = req.body as AdminConfig;
    saveAdminConfig(config);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving admin config:', error);
    res.status(500).json({ error: 'Failed to save admin config' });
  }
});

// Получить настройки для конкретного пула
app.get('/api/admin/pool-config/:poolAddress', (req, res) => {
  try {
    const { poolAddress } = req.params;
    
    // Валидация адреса пула
    try {
      new PublicKey(poolAddress);
    } catch (e) {
      return res.status(400).json({ error: 'Некорректный адрес пула' });
    }
    
    const config = getPoolConfig(poolAddress);
    if (!config) {
      return res.status(404).json({ error: 'Настройки для этого пула не найдены' });
    }
    
    res.json(config);
  } catch (error) {
    console.error('Error loading pool config:', error);
    res.status(500).json({ error: 'Failed to load pool config' });
  }
});

// Сохранить настройки для конкретного пула
app.post('/api/admin/pool-config/:poolAddress', (req, res) => {
  try {
    const { poolAddress } = req.params;
    const config = req.body as PoolConfig;
    
    // Валидация адреса пула
    try {
      new PublicKey(poolAddress);
    } catch (e) {
      return res.status(400).json({ error: 'Некорректный адрес пула' });
    }
    
    // Валидация конфигурации (priceCorridorPercent больше не используется)
    savePoolConfig(poolAddress, config);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving pool config:', error);
    res.status(500).json({ error: 'Failed to save pool config' });
  }
});

// Получить все пулы с настройками
app.get('/api/admin/pool-configs', (req, res) => {
  try {
    const configs = getAllPoolConfigs();
    res.json(configs);
  } catch (error) {
    console.error('Error loading pool configs:', error);
    res.status(500).json({ error: 'Failed to load pool configs' });
  }
});

// Закрыть позицию
app.post('/api/meteora/close-position', async (req, res) => {
  try {
    const { poolAddress, positionAddress, userPublicKey } = req.body || {};
    
    if (!poolAddress || !positionAddress || !userPublicKey) {
      return res.status(400).json({ error: 'poolAddress, positionAddress и userPublicKey обязательны' });
    }

    const connection = getConnection();
    const userPk = new PublicKey(String(userPublicKey));

    const transactions = await createClosePositionTransaction(
      connection,
      String(poolAddress),
      String(positionAddress),
      userPk,
    );

    // Обрабатываем массив транзакций или одну транзакцию
    const transactionsArray = Array.isArray(transactions) ? transactions : [transactions];
    const serialized = transactionsArray.map(tx => Buffer.from(tx.serialize()).toString('base64'));
    
    // Если одна транзакция, возвращаем как раньше для обратной совместимости
    if (serialized.length === 1) {
      res.json({ transaction: serialized[0] });
    } else {
      res.json({ transactions: serialized, count: serialized.length });
    }
  } catch (error) {
    console.error('Error creating close position tx:', error);
    res.status(500).json({ error: (error as Error).message || 'Create close position tx failed' });
  }
});

// Обновить статус позиции после закрытия
app.post('/api/positions/:positionAddress/close', (req, res) => {
  try {
    const { positionAddress } = req.params;
    const storage = new PositionStorage();
    
    const position = storage.getPosition(positionAddress);
    if (!position) {
      return res.status(404).json({ error: 'Position not found' });
    }
    
    // Обновляем статус позиции
    position.status = 'closed';
    position.closedAt = Date.now();
    storage.savePosition(position);
    
    res.json({ success: true, position });
  } catch (error) {
    console.error('Error updating position status:', error);
    res.status(500).json({ error: 'Failed to update position status' });
  }
});

// Проверить существование позиции на блокчейне
app.get('/api/positions/:positionAddress/verify', async (req, res) => {
  try {
    const { positionAddress } = req.params;
    const { poolAddress, userAddress } = req.query || {};
    
    if (!poolAddress || !userAddress) {
      return res.status(400).json({ error: 'poolAddress and userAddress are required' });
    }
    
    const connection = getConnection();
    
    try {
      const { getPositionInfo } = await import('./dex/meteora.js');
      await getPositionInfo(
        connection,
        poolAddress as string,
        positionAddress,
        new PublicKey(userAddress as string),
      );
      
      res.json({ exists: true, positionAddress });
    } catch (error) {
      // Если позиция не найдена, возвращаем exists: false
      if ((error as Error).message === 'Position not found') {
        res.json({ exists: false, positionAddress });
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error verifying position:', error);
    res.status(500).json({ 
      error: 'Failed to verify position',
      message: (error as Error).message,
    });
  }
});
// ====================================================

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});

