import { Connection, Keypair, VersionedTransaction, SendTransactionError, TransactionMessage } from '@solana/web3.js';

export async function signAndSend(
  connection: Connection,
  kp: Keypair,
  tx: VersionedTransaction,
): Promise<string> {
  try {
    // Проверяем blockhash транзакции
    const currentBlockhash = tx.message.recentBlockhash;
    
    // Если blockhash отсутствует или устарел, получаем свежий
    // НО: не пересоздаем транзакцию, так как это сломает подписи других подписантов (например, position keypair)
    // Вместо этого просто проверяем и логируем предупреждение
    if (!currentBlockhash) {
      console.warn('[Transaction] ⚠️ Transaction missing blockhash - this may cause signature verification failure');
    } else {
      // Проверяем актуальность blockhash
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      if (currentBlockhash !== latestBlockhash.blockhash) {
        console.warn(`[Transaction] ⚠️ Blockhash may be outdated: ${currentBlockhash.substring(0, 8)}... (current: ${latestBlockhash.blockhash.substring(0, 8)}...)`);
        console.warn('[Transaction] ⚠️ Transaction was created with old blockhash. If it fails, transaction needs to be recreated.');
      }
    }
    
    // Подписываем транзакцию (добавляем подпись пользователя)
    // ВАЖНО: не пересоздаем транзакцию, так как это сломает существующие подписи
    tx.sign([kp]);
    
    // Отправляем транзакцию
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });
    
    // Получаем актуальный blockhash для подтверждения
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    
    // Подтверждаем транзакцию
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      'confirmed',
    );
    return sig;
  } catch (error) {
    // Если это SendTransactionError, пытаемся получить детальные логи
    if (error instanceof SendTransactionError) {
      // signature может быть приватным, используем toString() или message для получения информации
      const errorMessage = error.message || String(error);
      console.error('[Transaction Error] Full details:', {
        message: errorMessage,
        error: String(error),
      });
      
      // Пробуем получить getLogs()
      try {
        const logs = await error.getLogs(connection);
        if (logs) {
          console.error('[Transaction Error] Detailed logs:', logs);
        }
      } catch (logError) {
        console.error('[Transaction Error] Failed to get logs:', logError);
      }
    } else {
      console.error('[Transaction Error]:', error);
    }
    
    throw error;
  }
}
