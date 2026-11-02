cd client
npm install

# Launch Market: Automatically triggers on-chain init + Twitter Thread + Discord/Slack Alert
npm run market:create -- \
  --id "sol-ath-2025" \
  --question "Will Solana break $300 all-time high before Q4 2025?" \
  --liquidity 1000000000 \
  --fee 100 \
  --duration 2592000