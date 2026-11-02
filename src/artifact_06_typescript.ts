import { Command } from 'commander';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { DaejinMarketAgent } from './agent';

dotenv.config();

const program = new Command();

program
  .name('daejin-cli')
  .description('Enterprise Automation CLI for Launching & Trading on Daejin')
  .version('1.0.0');

program
  .command('create-and-trade')
  .requiredOption('-b, --base <baseMint>', 'Base Token Mint Pubkey')
  .requiredOption('-q, --quote <quoteMint>', 'Quote Token Mint Pubkey')
  .requiredOption('-k, --keypair <path>', 'Path to Solana Wallet Keypair JSON')
  .option('--base-amount <amount>', 'Amount of base tokens to seed', '1000000000000')
  .option('--quote-amount <amount>', 'Amount of quote tokens to seed', '10000000000')
  .option('--fee-bps <bps>', 'Fee in Basis Points (e.g. 30 = 0.3%)', '30')
  .option('--trade-amount <tradeAmount>', 'Introductory trade quote amount', '1000000')
  .option('-s, --symbol <symbol>', 'Token Symbol', 'SOLSTICE')
  .action(async (options) => {
    const keypairRaw = JSON.parse(fs.readFileSync(options.keypair, 'utf-8'));
    const signer = Keypair.fromSecretKey(Uint8Array.from(keypairRaw));
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
    const programId = new PublicKey(process.env.DAEJIN_PROGRAM_ID || 'Daej1nMarketLauncher111111111111111111111111');
    const idl = JSON.parse(fs.readFileSync('./target/idl/daejin_market.json', 'utf-8'));

    const twitterKeys = {
      appKey: process.env.TWITTER_API_KEY || '',
      appSecret: process.env.TWITTER_API_SECRET || '',
      accessToken: process.env.TWITTER_ACCESS_TOKEN || '',
      accessSecret: process.env.TWITTER_ACCESS_SECRET || '',
    };

    const agent = new DaejinMarketAgent(
      rpcUrl,
      signer,
      programId,
      idl,
      twitterKeys,
      process.env.DISCORD_WEBHOOK_URL
    );

    const baseMint = new PublicKey(options.base);
    const quoteMint = new PublicKey(options.quote);

    console.log('🚀 Phase 1: Deploying Market and Seeding Liquidity...');
    const { txSig, marketAddress } = await agent.launchAndSeedMarket({
      baseMint,
      quoteMint,
      baseAmount: BigInt(options.baseAmount),
      quoteAmount: BigInt(options.quoteAmount),
      feeBps: parseInt(options.feeBps, 10),
    });

    console.log(`✅ Market initialized at: ${marketAddress.toBase58()}`);

    console.log('⚡ Phase 2: Executing initial bootstrapping trade...');
    const tradeSig = await agent.executeInitialTrade(
      baseMint,
      quoteMint,
      BigInt(options.tradeAmount),
      1n // 1 minimum amount out
    );
    console.log(`✅ Introductory trade confirmed: ${tradeSig}`);

    console.log('📢 Phase 3: Syndicating social announcements (X & Webhook)...');
    await agent.syndicateLaunchSocials(options.symbol, marketAddress, txSig);

    console.log('🎉 End-to-End Market Creation & Trade Pipeline Complete.');
  });

program.parse(process.argv);