import 'dotenv/config';

export const CONFIG = {
  // Используем более быстрый публичный RPC по умолчанию
  // Пользователь может изменить в настройках веб-интерфейса
  rpcUrl: process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com',
  secretKey: process.env.WALLET_SECRET_KEY ?? '',
  jup: {
    swapBase: process.env.JUP_SWAP_BASE ?? 'https://lite-api.jup.ag/swap/v1',
    tokensBase: process.env.JUP_TOKENS_BASE ?? 'https://lite-api.jup.ag/tokens/v2',
    priceEndpoint: process.env.JUP_PRICE_ENDPOINT ?? 'https://lite-api.jup.ag/price/v3',
    apiKey: process.env.JUP_API_KEY ?? '',
  },
  dlmmApiBase: process.env.DLMM_API_BASE ?? 'https://dlmm-api.meteora.ag',
};
