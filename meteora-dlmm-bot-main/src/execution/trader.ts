import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

export async function signAndSend(
  connection: Connection,
  kp: Keypair,
  tx: VersionedTransaction,
): Promise<string> {
  tx.sign([kp]);
  const latestBlockhash = await connection.getLatestBlockhash();
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    {
      signature: sig,
      ...latestBlockhash,
    },
    'confirmed',
  );
  return sig;
}
