import path from 'node:path';
import fs from 'node:fs';

export type TradeRow = {
  ts: number;
  leader: string;
  signature: string;
  inMint: string | null;
  outMint: string | null;
  inAmount: string | null;
  outAmount: string | null;
};

type JsonTradeStore = {
  filePath: string;
  cache: Map<string, TradeRow>;
};

function readTrades(filePath: string): TradeRow[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map(item => ({
        ts: Number(item.ts),
        leader: String(item.leader ?? ''),
        signature: String(item.signature ?? ''),
        inMint: item.inMint ?? null,
        outMint: item.outMint ?? null,
        inAmount: item.inAmount ?? null,
        outAmount: item.outAmount ?? null,
      }));
    }
  } catch (error) {
    console.warn('Failed to read trades DB, starting fresh:', error);
  }
  return [];
}

function writeTrades(filePath: string, rows: Iterable<TradeRow>) {
  const data = Array.from(rows);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function openDb(dbPath = path.join(process.cwd(), 'data', 'trades.json')): JsonTradeStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const existing = readTrades(dbPath);
  return {
    filePath: dbPath,
    cache: new Map(existing.map(trade => [trade.signature, trade])),
  };
}

export function insertTrade(db: JsonTradeStore, row: TradeRow) {
  if (db.cache.has(row.signature)) {
    return;
  }
  db.cache.set(row.signature, row);
  writeTrades(db.filePath, db.cache.values());
}
