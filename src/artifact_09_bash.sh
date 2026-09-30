# 1. Clone repository & install dependencies
git clone https://github.com/daejin-ecosystem/market-engine.git
cd market-engine
npm install

# 2. Build on-chain Solana Anchor program
anchor build

# 3. Deploy to Solana Devnet (or mainnet-beta)
solana program deploy ./target/deploy/daejin_engine.so \
  --program-id ./keys/program-keypair.json \
  --url https://api.devnet.solana.com

# 4. Generate local operator keypair if needed
solana-keygen new --no-passphrase -o ./keys/operator.json
solana airdrop 2 $(solana-keygen pubkey ./keys/operator.json) --url devnet

# 5. Launch new market and bootstrap liquidity
npm run launch -- \
  --market-id 1001 \
  --fee-bps 30 \
  --amount-a 500000000 \
  --amount-b 500000000

# 6. Execute an automated test trade
npm run trade -- \
  --market-id 1001 \
  --amount-in 1000000 \
  --direction a2b