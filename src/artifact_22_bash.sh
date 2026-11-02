# Set cluster configuration
solana config set --url https://api.devnet.solana.com

# Build BPF binary
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Deploy to Devnet / Mainnet
anchor deploy --provider.cluster devnet