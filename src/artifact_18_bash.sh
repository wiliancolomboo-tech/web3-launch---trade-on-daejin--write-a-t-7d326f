# Set cluster to devnet
solana config set --url https://api.devnet.solana.com

# Generate operator keypair if needed
solana-keygen new --outfile ./id.json --no-bip39-passphrase

# Build Anchor Program
anchor build

# Deploy Program
anchor deploy --provider.cluster devnet