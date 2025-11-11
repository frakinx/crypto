import { Connection } from '@solana/web3.js';

// Fixed Helius endpoint for all RPC calls
const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=f1ebee20-d1aa-46f8-b5b9-64f3ab23db3f';

export function getConnection(): Connection {
  return new Connection(HELIUS_RPC_URL, { commitment: 'confirmed' });
}
