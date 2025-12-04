import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Утилиты для работы с токенами и конвертацией единиц
 */

// Кэш для decimals токенов
const decimalsCache = new Map<string, number>();

// Известные токены с их decimals
const KNOWN_TOKENS: Record<string, number> = {
  'So11111111111111111111111111111111111111112': 9, // SOL/WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 6, // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 6, // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 9, // mSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 6, // ORCA (исправлено: 6 decimals, не 9!)
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 8, // ETH (Wormhole)
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM': 6, // USDC.e (Wormhole)
  'Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1': 6, // USDT (Wormhole)
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT': 6, // UXD Stablecoin
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 5, // BONK
};

/**
 * Получить decimals токена по mint адресу
 */
export async function getTokenDecimals(
  connection: Connection,
  mintAddress: string,
): Promise<number> {
  // Сначала проверяем известные токены (самый надежный источник, имеет приоритет над кэшем)
  if (KNOWN_TOKENS[mintAddress]) {
    const decimals = KNOWN_TOKENS[mintAddress];
    // Перезаписываем кэш правильным значением
    decimalsCache.set(mintAddress, decimals);
    return decimals;
  }

  // Затем проверяем кэш
  if (decimalsCache.has(mintAddress)) {
    return decimalsCache.get(mintAddress)!;
  }

  try {
    // Пытаемся получить через Jupiter API (проще и надежнее)
    try {
      const jupiterUrl = 'https://token.jup.ag/all';
      const response = await fetch(jupiterUrl);
      if (response.ok) {
        const tokens = await response.json() as any[];
        const token = tokens.find(t => 
          t.address === mintAddress || 
          t.mintAddress === mintAddress ||
          t.id === mintAddress
        );
        if (token && typeof token.decimals === 'number') {
          decimalsCache.set(mintAddress, token.decimals);
          return token.decimals;
        }
      }
    } catch (apiError) {
      // Продолжаем с RPC методом
    }

    // Получаем decimals из блокчейна через RPC
    // Mint аккаунт SPL Token имеет структуру:
    // Offset 0-35: mint authority (36 bytes)
    // Offset 36-43: supply (u64 = 8 bytes)
    // Offset 44: decimals (u8 = 1 byte)
    // Offset 45: isInitialized (u8 = 1 byte)
    // Offset 46-77: freezeAuthorityOption (Option<Pubkey> = 1 + 32 = 33 bytes)
    
    const mintPubkey = new PublicKey(mintAddress);
    const accountInfo = await connection.getAccountInfo(mintPubkey);
    
    if (!accountInfo) {
      throw new Error('Mint account not found');
    }
    
    if (accountInfo.data.length < 45) {
      throw new Error('Invalid mint account data length');
    }
    
    // Читаем decimals из байта 44 (u8)
    const decimals = accountInfo.data[44];
    
    if (decimals > 18) {
      throw new Error(`Invalid decimals value: ${decimals}`);
    }
    
    // Сохраняем в кэш
    decimalsCache.set(mintAddress, decimals);
    return decimals;
  } catch (error) {
    console.warn(`Failed to get decimals for ${mintAddress}, defaulting to 9:`, (error as Error).message);
    // По умолчанию возвращаем 9 (как у SOL)
    decimalsCache.set(mintAddress, 9);
    return 9;
  }
}

/**
 * Конвертировать количество токена из human-readable (например, 1.5 SOL) в минимальные единицы (lamports)
 * 
 * @param amount - количество в human-readable формате (например, 1.5)
 * @param decimals - количество десятичных знаков токена (например, 9 для SOL)
 * @returns количество в минимальных единицах (например, 1500000000 для 1.5 SOL)
 */
export function toSmallestUnits(amount: number | string, decimals: number): bigint {
  const amountNum = typeof amount === 'string' ? parseFloat(amount) : amount;
  
  if (isNaN(amountNum) || amountNum < 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  
  if (decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  
  // Умножаем на 10^decimals и округляем до целого
  const multiplier = 10n ** BigInt(decimals);
  const amountStr = amountNum.toFixed(decimals);
  const [integerPart, decimalPart = ''] = amountStr.split('.');
  
  // Обрабатываем целую часть
  const integerBigInt = BigInt(integerPart || '0') * multiplier;
  
  // Обрабатываем десятичную часть
  const decimalStr = decimalPart.padEnd(decimals, '0').slice(0, decimals);
  const decimalBigInt = BigInt(decimalStr || '0');
  
  return integerBigInt + decimalBigInt;
}

/**
 * Конвертировать количество токена из минимальных единиц в human-readable формат
 * 
 * @param amount - количество в минимальных единицах (например, 1500000000)
 * @param decimals - количество десятичных знаков токена (например, 9 для SOL)
 * @returns количество в human-readable формате (например, 1.5)
 */
export function fromSmallestUnits(amount: bigint | string | number, decimals: number): number {
  const amountBigInt = typeof amount === 'bigint' 
    ? amount 
    : typeof amount === 'string' 
      ? BigInt(amount) 
      : BigInt(Math.floor(amount));
  
  if (decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
  
  const divisor = 10n ** BigInt(decimals);
  const quotient = amountBigInt / divisor;
  const remainder = amountBigInt % divisor;
  
  // Конвертируем в число с правильным количеством знаков после запятой
  const result = Number(quotient) + Number(remainder) / Number(divisor);
  
  return result;
}

/**
 * Конвертировать количество токена из human-readable в минимальные единицы с автоматическим получением decimals
 * 
 * @param connection - соединение с Solana
 * @param amount - количество в human-readable формате (например, 1.5)
 * @param mintAddress - адрес mint токена
 * @returns количество в минимальных единицах
 */
export async function toSmallestUnitsAuto(
  connection: Connection,
  amount: number | string,
  mintAddress: string,
): Promise<bigint> {
  const decimals = await getTokenDecimals(connection, mintAddress);
  return toSmallestUnits(amount, decimals);
}

/**
 * Конвертировать количество токена из минимальных единиц в human-readable с автоматическим получением decimals
 * 
 * @param connection - соединение с Solana
 * @param amount - количество в минимальных единицах
 * @param mintAddress - адрес mint токена
 * @returns количество в human-readable формате
 */
export async function fromSmallestUnitsAuto(
  connection: Connection,
  amount: bigint | string | number,
  mintAddress: string,
): Promise<number> {
  const decimals = await getTokenDecimals(connection, mintAddress);
  return fromSmallestUnits(amount, decimals);
}

/**
 * Очистить кэш decimals
 */
export function clearDecimalsCache(): void {
  decimalsCache.clear();
}

/**
 * Предзагрузить decimals для списка токенов
 */
export async function preloadTokenDecimals(
  connection: Connection,
  mintAddresses: string[],
): Promise<void> {
  await Promise.all(
    mintAddresses.map(addr => getTokenDecimals(connection, addr))
  );
}

