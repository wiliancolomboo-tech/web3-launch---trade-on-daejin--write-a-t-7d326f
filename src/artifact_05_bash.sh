# 1. Clone repository and install dependencies
git clone https://github.com/daejin-ecosystem/daejin-market-engine.git
cd daejin-market-engine
yarn install

# 2. Build Anchor smart contract
anchor build

# 3. Synchronize program keys
solana address -k target/deploy/daejin_engine-keypair.json
# (Ensure declare_id! matches this address)

# 4. Run automated test suite
anchor test

# 5. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet