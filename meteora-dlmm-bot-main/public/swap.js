// ========== JUPITER SWAP (CLIENT) ==========
let lastJupQuote = null;
let tokenList = [];
let tokenIndexBySymbol = new Map();
let tokenIndexByAddress = new Map();
const TOP_TOKENS = {
  SOL: 'So11111111111111111111111111111111111111112', // WSOL
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

const TOKEN_CACHE_KEY = 'jupiter-token-list';
const TOKEN_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24h

function normalizeTokenShape(token) {
  if (!token || typeof token !== 'object') return null;
  const address = token.address || token.id;
  if (!address) return null;
  const symbol = token.symbol ? String(token.symbol).toUpperCase() : '';
  const name = token.name ? String(token.name) : '';
  const decimals = typeof token.decimals === 'number' ? token.decimals : undefined;
  const logoURI = token.logoURI || token.icon || token.logo || undefined;
  const tags = Array.isArray(token.tags) ? token.tags : undefined;
  const verified =
    typeof token.verified === 'boolean'
      ? token.verified
      : typeof token.isVerified === 'boolean'
        ? token.isVerified
        : Array.isArray(tags) && tags.includes('verified');
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

function buildTokenIndexes() {
  tokenIndexBySymbol.clear();
  tokenIndexByAddress.clear();
  for (const raw of tokenList) {
    const token = normalizeTokenShape(raw);
    if (!token) continue;
    tokenIndexByAddress.set(token.address, token);
    if (token.symbol) {
      tokenIndexBySymbol.set(token.symbol.toLowerCase(), token);
    }
  }
}

function persistTokenCache() {
  try {
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify({ data: tokenList, timestamp: Date.now() }));
  } catch (_) {
    // ignore quota errors
  }
}

function setTokenList(tokens, { persist = false } = {}) {
  tokenList = [];
  if (Array.isArray(tokens)) {
    for (const entry of tokens) {
      const normalized = normalizeTokenShape(entry);
      if (normalized) {
        tokenList.push(normalized);
      }
    }
  }
  // Sort by symbol then name for stable UX
  tokenList.sort((a, b) => {
    const left = (a.symbol || a.name || a.address || '').toLowerCase();
    const right = (b.symbol || b.name || b.address || '').toLowerCase();
    return left.localeCompare(right);
  });
  buildTokenIndexes();
  if (persist) {
    persistTokenCache();
  }
}

function mergeTokenList(tokens, { persist = false } = {}) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const index = new Map(tokenList.map(t => [t.address, t]));
  let changed = false;
  for (const entry of tokens) {
    const normalized = normalizeTokenShape(entry);
    if (!normalized) continue;
    if (index.has(normalized.address)) {
      const existing = index.get(normalized.address);
      const updated = { ...existing, ...normalized };
      index.set(normalized.address, updated);
    } else {
      index.set(normalized.address, normalized);
      changed = true;
    }
  }
  if (changed) {
    tokenList = Array.from(index.values());
    tokenList.sort((a, b) => {
      const left = (a.symbol || a.name || a.address || '').toLowerCase();
      const right = (b.symbol || b.name || b.address || '').toLowerCase();
      return left.localeCompare(right);
    });
  } else {
    tokenList = tokenList.map(t => index.get(t.address) ?? t);
  }
  buildTokenIndexes();
  if (persist) {
    persistTokenCache();
  }
}

function searchTokensLocal(query) {
  if (!query || query.length < 2) return [];
  const lower = query.toLowerCase();
  return tokenList
    .filter(
      t =>
        (t.symbol && t.symbol.toLowerCase().includes(lower)) ||
        (t.name && t.name.toLowerCase().includes(lower)) ||
        (t.address && t.address.toLowerCase().includes(lower)),
    )
    .slice(0, 10);
}

async function fetchTokenSuggestions(query) {
  const response = await fetch(`/api/tokens/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) {
    throw new Error(`Token search failed with status ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function initJupiterSwap() {
  const getQuoteBtn = document.getElementById('jupGetQuoteBtn');
  const swapBtn = document.getElementById('jupSwapBtn');

  if (getQuoteBtn) {
    getQuoteBtn.addEventListener('click', handleGetJupQuote);
  }
  if (swapBtn) {
    swapBtn.addEventListener('click', handleDoJupSwap);
  }

  // Enable autocomplete immediately, token list loads in background
  initTokenSearch();
  loadTokenList().then(() => {
    buildTokenIndexes();
    updateSwapAmountHint(); // Обновляем подсказку после загрузки токенов
  });

  // Quick chips
  document.querySelectorAll('.token-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const role = btn.getAttribute('data-role'); // input | output
      const sym = btn.getAttribute('data-symbol');
      setTokenQuick(role, sym);
      // toggle active state
      document.querySelectorAll(`.token-chip[data-role="${role}"]`).forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-symbol') === sym);
      });
    });
  });
}

function showJupQuoteStatus(message, type) {
  const el = document.getElementById('jupQuoteResult');
  if (!el) return;
  el.style.display = 'block';
  el.className = `rpc-status ${type}`;
  el.querySelector('.status-message').textContent = message;
}

function showJupSwapStatus(message, type) {
  const el = document.getElementById('jupSwapResult');
  if (!el) return;
  el.style.display = 'block';
  el.className = `rpc-status ${type}`;
  el.querySelector('.status-message').textContent = message;
}

function showTokenListStatus(message, type) {
  const statusEl = document.getElementById('swap-status');
  if (!statusEl) return;
  statusEl.style.display = 'block';
  statusEl.className = `rpc-status ${type}`;
  statusEl.dataset.source = 'token-list';
  const msgEl = statusEl.querySelector('.status-message');
  if (msgEl) {
    msgEl.textContent = message;
  }
}

function hideTokenListStatus() {
  const statusEl = document.getElementById('swap-status');
  if (statusEl && statusEl.dataset.source === 'token-list') {
    statusEl.style.display = 'none';
    delete statusEl.dataset.source;
  }
}

// Конвертация из обычных единиц в минимальные единицы (с учетом decimals)
function convertToSmallestUnits(amount, decimals) {
  if (!decimals || decimals === 0) {
    // Если decimals неизвестен, предполагаем стандартные значения
    // SOL = 9, USDC/USDT = 6
    return Math.floor(Number(amount) * 1e9);
  }
  return Math.floor(Number(amount) * Math.pow(10, decimals));
}

// Получить decimals токена
function getTokenDecimals(mintAddress) {
  const token = tokenIndexByAddress.get(mintAddress);
  if (token && token.decimals !== undefined) {
    return token.decimals;
  }
  // Дефолтные значения для популярных токенов
  const defaultDecimals = {
    'So11111111111111111111111111111111111111112': 9, // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
  };
  return defaultDecimals[mintAddress] || 9; // По умолчанию 9 (как SOL)
}

// Обновить подсказку для суммы свапа
function updateSwapAmountHint() {
  const inputMint = document.getElementById('inputMint')?.value?.trim();
  const hintEl = document.getElementById('swapAmountHint');
  if (!hintEl) return;
  
  if (inputMint) {
    const token = tokenIndexByAddress.get(inputMint);
    const symbol = token?.symbol || 'токена';
    hintEl.textContent = `Введите количество в единицах ${symbol} (например, 1 для 1 ${symbol})`;
  } else {
    hintEl.textContent = 'Введите количество токенов (например, 1 для 1 SOL, 100 для 100 USDC)';
  }
}

async function handleGetJupQuote() {
  try {
    hideTokenListStatus();

    // Ensure mints are resolved even if user typed symbols without selecting from dropdown
    const inputMint = (ensureMintSelected('input') || document.getElementById('inputMint')?.value || '').trim();
    const outputMint = (ensureMintSelected('output') || document.getElementById('outputMint')?.value || '').trim();
    const amountStr = document.getElementById('swapAmount').value.trim();
    const slippageBpsStr = document.getElementById('swapSlippage').value.trim();

    if (!inputMint || !outputMint || !amountStr) {
      showJupQuoteStatus('Введите токены и сумму', 'error');
      const swapStatus = document.getElementById('swap-status');
      if (swapStatus) {
        swapStatus.style.display = 'block';
        swapStatus.className = 'rpc-status error';
        swapStatus.querySelector('.status-message').textContent = 'Введите токены и сумму';
      }
      return;
    }

    // Конвертируем из обычных единиц в минимальные единицы
    const decimals = getTokenDecimals(inputMint);
    const amountInSmallestUnits = convertToSmallestUnits(amountStr, decimals);

    const payload = {
      inputMint,
      outputMint,
      amount: amountInSmallestUnits,
      slippageBps: Number(slippageBpsStr) || 100,
    };

    showJupQuoteStatus('Запрос котировки...', 'info');

    const res = await fetch('/api/jup/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Quote request failed');
    }

    lastJupQuote = data;
    showJupQuoteStatus('Котировка получена. Можно выполнять свап.', 'success');

    const swapStatus = document.getElementById('swap-status');
    if (swapStatus) {
      const inputAmount = data.inputAmount ?? data.inAmount ?? '—';
      const outputAmount = data.outputAmount ?? data.outAmount ?? '—';
      swapStatus.style.display = 'block';
      swapStatus.className = 'rpc-status success';
      swapStatus.dataset.source = 'quote';
      swapStatus.querySelector('.status-message').textContent = `✅ Quote received: ${inputAmount} → ${outputAmount}`;
    }
  } catch (err) {
    console.error('Jupiter quote error:', err);
    const rawMessage = err?.message || 'Unknown';
    let humanMessage = `❌ Ошибка котировки: ${rawMessage}`;
    if (/DNS_ERROR/.test(rawMessage)) {
      humanMessage = '❌ Не удалось подключиться к lite-api.jup.ag. Проверьте DNS/прокси или задайте JUP_SWAP_BASE на доступный endpoint.';
    } else if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH/.test(rawMessage)) {
      humanMessage = '❌ Не удалось подключиться к lite-api.jup.ag. Проверьте DNS/прокси или установите альтернативный endpoint в настройках.';
    } else if (rawMessage.includes('Failed to fetch')) {
      humanMessage = '❌ Не удалось обратиться к серверу котировок. Проверьте интернет-соединение или VPN.';
    }
    showJupQuoteStatus(humanMessage, 'error');
    const swapStatus = document.getElementById('swap-status');
    if (swapStatus) {
      swapStatus.style.display = 'block';
      swapStatus.className = 'rpc-status error';
      swapStatus.dataset.source = 'quote';
      const msgEl = swapStatus.querySelector('.status-message');
      if (msgEl) {
        msgEl.textContent = humanMessage;
      }
    }
  }
}

// ----- Token search / list loading -----
async function loadTokenList() {
  try {
    const cached = localStorage.getItem(TOKEN_CACHE_KEY);
    if (cached) {
      const { data, timestamp } = JSON.parse(cached);
      if (Date.now() - timestamp < TOKEN_CACHE_DURATION) {
        setTokenList(data);
        hideTokenListStatus();
        console.log('Loaded tokens from cache:', tokenList.length);
        return;
      }
    }
  } catch (_) {}

  try {
    const response = await fetch('/api/tokens');
    if (!response.ok) {
      throw new Error(`Token API responded with status ${response.status}`);
    }
    const fresh = await response.json();
    setTokenList(fresh, { persist: true });
    hideTokenListStatus();
    console.log('Loaded fresh tokens:', tokenList.length);
  } catch (error) {
    console.error('Failed to load token list:', error);
    tokenList = [];
    showTokenListStatus('❌ Не удалось загрузить список токенов. Проверьте доступ к lite-api.jup.ag или настройте DNS.', 'error');
  }
}


function buildTokenIndexes() {
  tokenIndexBySymbol.clear();
  tokenIndexByAddress.clear();
  for (const t of tokenList) {
    if (t.symbol) {
      const key = String(t.symbol).toLowerCase();
      if (!tokenIndexBySymbol.has(key)) tokenIndexBySymbol.set(key, t);
    }
    if (t.address) {
      tokenIndexByAddress.set(String(t.address), t);
    }
  }
  // Делаем доступным глобально для использования в других модулях
  window.tokenIndexByAddress = tokenIndexByAddress;
  window.tokenIndexBySymbol = tokenIndexBySymbol;
}

function searchTokens(query) {
  if (!query || query.length < 2) return [];
  const lower = query.toLowerCase();
  return tokenList.filter(t =>
    (t.symbol && t.symbol.toLowerCase().includes(lower)) ||
    (t.name && t.name.toLowerCase().includes(lower)) ||
    (t.address && t.address.toLowerCase().includes(lower))
  ).slice(0, 10);
}

function initTokenSearch() {
  const inputSearch = document.getElementById('inputTokenSearch');
  const outputSearch = document.getElementById('outputTokenSearch');
  const inputDropdown = document.getElementById('inputTokenDropdown');
  const outputDropdown = document.getElementById('outputTokenDropdown');
  const inputMint = document.getElementById('inputMint');
  const outputMint = document.getElementById('outputMint');
  const inputInfo = document.getElementById('inputTokenInfo');
  const outputInfo = document.getElementById('outputTokenInfo');

  function setupAutocomplete(inputEl, dropdownEl, mintEl, infoEl) {
    if (!inputEl || !dropdownEl || !mintEl || !infoEl) return;

    function renderResults(results) {
      if (!results.length) {
        dropdownEl.style.display = 'none';
        return;
      }

      dropdownEl.innerHTML = '';
      results.forEach(token => {
        const option = document.createElement('div');
        option.className = 'token-option';
        option.innerHTML = `
          <div>
            <div class="token-symbol">${token.symbol || '-'}</div>
            <div class="token-name">${token.name || ''}</div>
          </div>
          <div class="token-address">${(token.address || '').slice(0, 8)}...</div>
        `;
        option.addEventListener('click', () => {
          inputEl.value = token.symbol || token.name || token.address;
          mintEl.value = token.address;
          infoEl.innerHTML = `${token.name || ''} (${token.address})`;
          dropdownEl.style.display = 'none';
          
          // Обновляем подсказку для суммы свапа
          if (inputEl.id === 'inputTokenSearch') {
            updateSwapAmountHint();
          }
        });
        dropdownEl.appendChild(option);
      });
      dropdownEl.style.display = 'block';
    }

    let debounceId = null;
    let requestSeq = 0;
    inputEl.addEventListener('input', function () {
      const rawValue = String(this.value || '');
      clearTimeout(debounceId);
      debounceId = setTimeout(async () => {
        const query = rawValue.trim();
        const role = inputEl.id.startsWith('input') ? 'input' : 'output';
        document.querySelectorAll(`.token-chip[data-role="${role}"]`).forEach(b => b.classList.remove('active'));

        if (!tokenList || tokenList.length === 0) {
          dropdownEl.innerHTML = '<div class="token-option">Загрузка списка токенов...</div>';
          dropdownEl.style.display = 'block';
          return;
        }

        // Prefill on exact symbol hit
        const exact = tokenIndexBySymbol.get(query.toLowerCase());
        if (exact) {
          mintEl.value = exact.address;
          infoEl.innerHTML = `${exact.name || ''} (${exact.address})`;
          
          // Обновляем подсказку для суммы свапа
          if (inputEl.id === 'inputTokenSearch') {
            updateSwapAmountHint();
          }
        }

        const localResults = searchTokensLocal(query);
        renderResults(localResults);

        if (query.length < 2) {
          return;
        }

        const seq = ++requestSeq;
        try {
          const remote = await fetchTokenSuggestions(query);
          mergeTokenList(remote, { persist: false });
          if (seq !== requestSeq) return;
          const combinedMap = new Map();
          for (const token of [...localResults, ...remote]) {
            const normalized = normalizeTokenShape(token);
            if (!normalized) continue;
            combinedMap.set(normalized.address, normalized);
          }
          const combined = Array.from(combinedMap.values()).slice(0, 10);
          renderResults(combined);
        } catch (error) {
          console.error('Token search request failed:', error);
        }
      }, 200);
    });

    // Show top tokens on focus
    inputEl.addEventListener('focus', () => {
      const defaults = [
        tokenIndexBySymbol.get('sol'),
        tokenIndexBySymbol.get('usdc'),
        tokenIndexBySymbol.get('usdt'),
      ].filter(Boolean);
      if (defaults.length) {
        renderResults(defaults);
      } else {
        dropdownEl.innerHTML = '<div class="token-option">Начните вводить название или символ...</div>';
        dropdownEl.style.display = 'block';
      }
    });
    
    // Обновляем подсказку при изменении mint
    mintEl.addEventListener('change', () => {
      if (inputEl.id === 'inputTokenSearch') {
        updateSwapAmountHint();
      }
    });

    // Hide on escape
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dropdownEl.style.display = 'none';
      }
    });

    document.addEventListener('click', function(e) {
      if (!dropdownEl.contains(e.target) && e.target !== inputEl) {
        dropdownEl.style.display = 'none';
      }
    });
  }

  setupAutocomplete(inputSearch, inputDropdown, inputMint, inputInfo);
  setupAutocomplete(outputSearch, outputDropdown, outputMint, outputInfo);
}

function setTokenQuick(role, symbol) {
  const sym = String(symbol).toUpperCase();
  const address = TOP_TOKENS[sym];
  const mintEl = document.getElementById(role === 'input' ? 'inputMint' : 'outputMint');
  const searchEl = document.getElementById(role === 'input' ? 'inputTokenSearch' : 'outputTokenSearch');
  const infoEl = document.getElementById(role === 'input' ? 'inputTokenInfo' : 'outputTokenInfo');
  if (!address || !mintEl || !searchEl || !infoEl) return;
  mintEl.value = address;
  searchEl.value = sym;
  const token = tokenIndexByAddress.get(address) || { symbol: sym, name: sym, address };
  infoEl.innerHTML = `${token.name || token.symbol || sym} (${address})`;
  
  // Обновляем подсказку для суммы свапа
  if (role === 'input') {
    updateSwapAmountHint();
  }
  
  // activate chip UI handled in initJupiterSwap click handler
}

function resolveMintFromQuery(query) {
  if (!query) return null;
  const q = String(query).trim();
  // Exact address
  const exactAddr = tokenList.find(t => t.address === q);
  if (exactAddr) return exactAddr.address;
  // Exact symbol
  const sym = q.toLowerCase();
  const bySym = tokenList.find(t => String(t.symbol || '').toLowerCase() === sym);
  if (bySym) return bySym.address;
  // Fallback: first search result
  const results = searchTokensLocal(q);
  return results.length ? results[0].address : null;
}

function ensureMintSelected(which) {
  const mintEl = document.getElementById(which === 'input' ? 'inputMint' : 'outputMint');
  const searchEl = document.getElementById(which === 'input' ? 'inputTokenSearch' : 'outputTokenSearch');
  const infoEl = document.getElementById(which === 'input' ? 'inputTokenInfo' : 'outputTokenInfo');
  if (!mintEl || !searchEl || !infoEl) return null;
  const current = (mintEl.value || '').trim();
  if (current) return current;
  const resolved = resolveMintFromQuery(searchEl.value);
  if (resolved) {
    mintEl.value = resolved;
    const token = tokenList.find(t => t.address === resolved) || null;
    if (token) {
      infoEl.innerHTML = `${token.name || token.symbol || ''} (${resolved})`;
      if (!searchEl.value) searchEl.value = token.symbol || token.name || resolved.slice(0, 6);
    } else {
      infoEl.innerHTML = resolved;
    }
    return resolved;
  }
  return null;
}

async function handleDoJupSwap() {
  try {
    if (!walletPublicKey) {
      showJupSwapStatus('Подключите Phantom кошелек', 'error');
      return;
    }
    if (!lastJupQuote) {
      showJupSwapStatus('Сначала получите котировку', 'error');
      return;
    }

    // Ensure selected mints are set to reduce user friction
    ensureMintSelected('input');
    ensureMintSelected('output');

    const userPublicKey = walletPublicKey;

    showJupSwapStatus('Генерация транзакции...', 'info');

    // 1) Запрашиваем у сервера swap-транзакцию (base64)
    const res = await fetch('/api/jup/swap-tx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPublicKey,
        quoteResponse: lastJupQuote,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Swap tx create failed');
    }

    const swapTxBase64 = data.swapTransaction;

    // 2) Десериализуем и подписываем в Phantom
    const txBytes = Uint8Array.from(atob(swapTxBase64), c => c.charCodeAt(0));
    const tx = solanaWeb3.VersionedTransaction.deserialize(txBytes);

    const provider = getPhantomProvider();
    if (!provider) {
      throw new Error('Phantom не найден');
    }

    // Подписываем
    const signed = await provider.signTransaction(tx);

    // 3) Отправляем через наш сервер на Helius
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
    showJupSwapStatus(`Свап отправлен! Signature: ${sig}`, 'success');
  } catch (err) {
    console.error('Jupiter swap error:', err);
    showJupSwapStatus('Ошибка свапа: ' + (err.message || 'Unknown'), 'error');
  }
}


