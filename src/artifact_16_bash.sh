# 1. Build optimized program binary using Anchor
anchor build

# 2. Sync program keys
anchor keys sync

# 3. Deploy to Solana Devnet
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json \
  target/deploy/daejin_market.so

# 4. Initialize node environment & dependencies
cd client && npm install