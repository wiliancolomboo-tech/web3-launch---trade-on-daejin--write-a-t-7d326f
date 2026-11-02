# 1. Clone & install dependencies
git clone https://github.com/daejin-ecosystem/market-launcher.git
cd market-launcher
npm install

# 2. Build and verify Anchor smart contract
anchor build
anchor test

# 3. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name daejin_market_core

# 4. Configure Environment variables
cp .env.example .env
# Fill out TWITTER_* keys and SOLANA_RPC_URL

# 5. Execute 1-Click Market Launch, Seed Liquidity, & Twitter Thread Broadcast
npm run launch-and-post