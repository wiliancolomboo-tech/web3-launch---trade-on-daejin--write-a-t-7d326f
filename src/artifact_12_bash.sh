# 1. Build Smart Contract
anchor build

# 2. Deploy to Solana Devnet/Mainnet
solana program deploy \
  --program-id target/deploy/daejin_market-keypair.json \
  target/deploy/daejin_market.so \
  --url https://api.devnet.solana.com

# 3. Execute Anchor Test Suite
anchor test --skip-local-validator

# 4. Launch Market via Daejin Engine CLI
node dist/index.js launch-market \
  --keypair ./keys/id.json \
  --base <BASE_TOKEN_MINT> \
  --quote <QUOTE_TOKEN_MINT> \
  --fee 100 \
  --base-amount 1000000000000 \
  --quote-amount 50000000000