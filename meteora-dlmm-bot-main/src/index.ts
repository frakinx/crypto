import { CONFIG } from './config.js';
import { getConnection } from './rpc.js';
import { loadKeypairFromEnv } from './utils/wallet.js';
import { PositionMonitor } from './position-monitoring/monitor.js';

async function main() {
  console.log('Starting Meteora Position Monitor Bot...');
  const conn = getConnection();
  const kp = loadKeypairFromEnv(CONFIG.secretKey);
  console.log('Bot pubkey:', kp.publicKey.toBase58());

  // Запускаем мониторинг позиций сразу при старте
  console.log('Starting position monitoring...');
  const positionMonitor = new PositionMonitor(conn, kp);
  positionMonitor.start();
  console.log('Position monitoring started');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
