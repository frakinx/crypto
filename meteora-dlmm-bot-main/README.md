<div align="center">

# 🚀 Meteora DLMM Position Monitor Bot

meteora / meteora dlmm / meteora dlmm bot / meteora dlmm position monitor / meteora position monitor / meteora bot

_Automated position monitoring and management for Solana — powered by **Meteora DLMM** & **Jupiter v6**._

![Solana](https://img.shields.io/badge/Solana-Meteora-purple?logo=solana&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Node.js-blue?logo=typescript)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

</div>

---

## ✨ Features

- 📊 **Position Monitoring**  
  Automatic monitoring and management of DLMM liquidity positions.  
  Real-time price tracking, automated position decisions, and hedge swapping.  

- 🎯 **Smart Position Management**  
  - Automatic stop loss and take profit  
  - Fee vs loss calculations for optimal exit timing  
  - Hedge swapping via Mirror Swapping strategy  
  - Automatic pool selection based on liquidity and volume  

- 📈 **Pool Scanner**  
  Fetches all active **DLMM pools** and computes potential APR based on liquidity, volume and fee structure.  

- ⚙️ **Configurable Strategy**  
  - Adjustable price corridors (upper/lower bounds)  
  - Customizable monitoring intervals  
  - Pool selection criteria (liquidity, volume, bin step)  

---

## 📂 Project Structure

```
meteora-dlmm-bot/
├── src/
│   ├── analytics/            # Pool scanner & APR estimator
│   ├── dex/                  # Jupiter & Meteora SDK wrappers
│   ├── execution/            # Transaction signing/sending
│   ├── position-monitoring/  # Position monitoring & management
│   ├── utils/                # Wallet helpers & validators
│   ├── config.ts             # Config loader (.env)
│   └── index.ts              # Bot entrypoint
├── .env.example              # Environment variables template
├── package.json
└── README.md
```

---

## ⚡ Quick Start

1. Clone the repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and configure your settings
4. Run the bot: `npm start`

---

## 🔧 Configuration (`.env`)

| Variable             | Description |
|----------------------|-------------|
| `RPC_URL`            | Solana RPC endpoint (private RPC recommended) |
| `WALLET_SECRET_KEY`  | Base58 or JSON array secret key (⚠️ use test wallet for dev) |
| `JUP_API_KEY`        | (Optional) Jupiter API key (required for Pro endpoints) |
| `JUP_SWAP_BASE`      | Jupiter Swap API base (defaults to `https://lite-api.jup.ag/swap/v1`) |
| `JUP_TOKENS_BASE`    | Jupiter Tokens API base (defaults to `https://lite-api.jup.ag/tokens/v2`) |
| `JUP_PRICE_ENDPOINT` | Jupiter Price API endpoint (defaults to `https://lite-api.jup.ag/price/v3`) |
| `DLMM_API_BASE`      | Meteora DLMM API base (defaults to `https://dlmm-api.meteora.ag`) |

Position monitoring settings are configured via the admin interface or `data/settings.json`.

---

## 📡 How It Works

1. **Position Monitoring**  
   Continuously monitors all active DLMM positions, tracking:
   - Current pool prices via Meteora SDK and Jupiter Price API
   - Position boundaries (upper/lower price corridors)
   - Accumulated fees vs potential losses
   - Price movements relative to position bounds

2. **Automated Decisions**  
   Makes intelligent position management decisions:
   - **Close** when price hits upper bound (take profit)
   - **Hedge** when price moves significantly (Mirror Swapping)
   - **Close** if fees cover losses from stop loss
   - **Open new position** below current price when profitable

3. **Pool Scanner**  
   Scans available DLMM pools and computes potential metrics:  
   ```
   feeAPR ≈ (24h Volume × Avg Fee) / Liquidity × 365
   ```
   Automatically selects best pools based on liquidity, volume, and bin step criteria.

---

## 📊 Example Output

```
Starting Meteora Position Monitor Bot...
Bot pubkey: YourWallet...
Starting position monitoring...
Position monitoring started
[Position Monitor] Checking positions...
[Position] SOL/USDC: Price at 85% of range, holding
[Position] BONK/SOL: Price hit upper bound, closing position
[Position Monitor] Opened new position in RAY/USDC pool
```

---
## 🔐 Security & Compliance
- Designed for **hot wallets only** — keep cold storage secure
- Always respect **laws & platform rules**
- Test thoroughly on devnet before using on mainnet

---

## 📜 License

(LICENSE) © 2025 — Feel free to fork, hack, and extend.
