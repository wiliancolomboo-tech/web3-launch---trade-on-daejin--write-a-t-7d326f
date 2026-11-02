# 1. Build smart contract and compile Anchor IDL
anchor build

# 2. Extract freshly generated program keypair
solana address -k target/deploy/daejin_market-keypair.json

# 3. Synchronize program ID in lib.rs & Anchor.toml, then rebuild
anchor keys sync
anchor build

# 4. Deploy to Solana Devnet (Ensure local Solana wallet has SOL)
anchor deploy --provider.cluster devnet

# 5. Initialize client environment
cd client
cp .env.example .env
npm install
npm run build