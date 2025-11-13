import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { getConnection } from './rpc.js';
import { getQuote as jupGetQuote, createSwapTransaction as jupCreateSwapTx } from './dex/jupiter.js';
import { CONFIG } from './config.js';

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

