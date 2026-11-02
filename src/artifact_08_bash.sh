# 1. Install Anchor 0.30.1 & Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

# 2. Build on-chain program
anchor build

# 3. Synchronize deployed Program ID
anchor keys sync

# 4. Deploy to Solana Devnet (or Mainnet)
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Execute 1-Click Turnkey Market Creation & Trade
ts-node src/index.ts create-and-trade \
  --base <BASE_TOKEN_MINT> \
  --quote So11111111111111111111111111111111111111112 \
  --keypair ~/.config/solana/id.json \
  --base-amount 1000000000000 \
  --quote-amount 50000000000 \
  --fee-bps 30 \
  --symbol SOLSTICE