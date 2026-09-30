import { Command } from 'commander';
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  sendAndConfirmTransaction,
  Transaction,
  SystemProgram
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import pino from 'pino';
import { EnterpriseNotifier } from './notifier';

dotenv.config();

const logger = pino({
  transport: { target: 'pino-pretty' }
});

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || 'Daej1nMarketEng1ne111111111111111111111111111'
);

function loadKeypair(keypairPath: string): Keypair {
  const secretKeyString = fs.readFileSync(path.resolve(keypairPath), 'utf8');
  const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
  return Keypair.fromSecretKey(secretKey);
}

const notifier = new EnterpriseNotifier();

const program = new Command();

program
  .name('daejin-cli')
  .description('Autonomous Market Launch & Trader CLI for Daejin on Solana')
  .version('1.0.0');

program
  .command('launch')
  .description('Deploy fresh token pair, establish Daejin Market, and seed initial liquidity')
  .option('-k, --keypair <path>', 'Operator keypair JSON path', './keys/operator.json')
  .option('-e, --endpoint <url>', 'Solana RPC endpoint', clusterApiUrl('devnet'))
  .option('-m, --market-id <number>', 'Unique 64-bit Market Identifier', String(Date.now()))
  .option('-f, --fee-bps <number>', 'Protocol swap fee in bps', '30')
  .option('--amount-a <number>', 'Initial base token seed quantity', '100000000000') // 100k tokens (6 decimals)
  .option('--amount-b <number>', 'Initial quote token seed quantity', '100000000000')
  .action(async (opts) => {
    try {
      logger.info('Starting Daejin Market Launch Sequence...');
      const connection = new Connection(opts.endpoint, 'confirmed');
      const operator = loadKeypair(opts.keypair);
      const wallet = new Wallet(operator);
      const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

      logger.info(`Operator public key: ${operator.publicKey.toBase58()}`);

      // 1. Provision Token A and Token B mints
      logger.info('Minting Token A (Base Asset) and Token B (Quote Asset)...');
      const mintA = await createMint(connection, operator, operator.publicKey, null, 6);
      const mintB = await createMint(connection, operator, operator.publicKey, null, 6);
      logger.info(`Base Token Mint: ${mintA.toBase58()}`);
      logger.info(`Quote Token Mint: ${mintB.toBase58()}`);

      // 2. Fund Operator Token Accounts
      const operatorTokenA = await getOrCreateAssociatedTokenAccount(connection, operator, mintA, operator.publicKey);
      const operatorTokenB = await getOrCreateAssociatedTokenAccount(connection, operator, mintB, operator.publicKey);

      await mintTo(connection, operator, mintA, operatorTokenA.address, operator, BigInt(opts.amountA) * 2n);
      await mintTo(connection, operator, mintB, operatorTokenB.address, operator, BigInt(opts.amountB) * 2n);
      logger.info('Operator accounts funded with initial balance.');

      // 3. Derive PDA accounts
      const marketId = new BN(opts.marketId);
      const marketIdBuffer = marketId.toArrayLike(Buffer, 'le', 8);

      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), marketIdBuffer],
        PROGRAM_ID
      );
      const [vaultAPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_a'), marketPda.toBuffer()],
        PROGRAM_ID
      );
      const [vaultBPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_b'), marketPda.toBuffer()],
        PROGRAM_ID
      );
      const [lpMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('lp_mint'), marketPda.toBuffer()],
        PROGRAM_ID
      );

      logger.info(`Market PDA: ${marketPda.toBase58()}`);
      logger.info(`Vault A PDA: ${vaultAPda.toBase58()}`);
      logger.info(`Vault B PDA: ${vaultBPda.toBase58()}`);
      logger.info(`LP Mint PDA: ${lpMintPda.toBase58()}`);

      // 4. Load Anchor IDL & Program
      const idl = (await Program.fetchIdl(PROGRAM_ID, provider))!;
      const daejinProgram = new Program(idl, provider);

      // 5. Initialize Market Instruction
      logger.info('Submitting initialize_market transaction...');
      const initTx = await daejinProgram.methods
        .initializeMarket(marketId, parseInt(opts.feeBps))
        .accounts({
          authority: operator.publicKey,
          market: marketPda,
          mintA: mintA,
          mintB: mintB,
          vaultA: vaultAPda,
          vaultB: vaultBPda,
          lpMint: lpMintPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      logger.info(`Market successfully initialized. Signature: ${initTx}`);

      // 6. Deposit Seed Liquidity
      const operatorLp = await getOrCreateAssociatedTokenAccount(connection, operator, lpMintPda, operator.publicKey);
      logger.info('Depositing initial liquidity bundle...');

      const depositTx = await daejinProgram.methods
        .depositLiquidity(new BN(opts.amountA), new BN(opts.amountB), new BN(1))
        .accounts({
          user: operator.publicKey,
          market: marketPda,
          vaultA: vaultAPda,
          vaultB: vaultBPda,
          lpMint: lpMintPda,
          userTokenA: operatorTokenA.address,
          userTokenB: operatorTokenB.address,
          userLp: operatorLp.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      logger.info(`Seed Liquidity active. Signature: ${depositTx}`);

      // 7. Dispatch enterprise notifications
      await notifier.broadcast({
        marketId: opts.marketId,
        marketAddress: marketPda.toBase58(),
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        action: 'INITIALIZED',
        txSignature: initTx,
        details: {
          seedAmountA: opts.amountA,
          seedAmountB: opts.amountB,
          feeBps: opts.feeBps,
          depositTxSignature: depositTx
        }
      });

      console.log('\n================ MARKET LAUNCH MANIFEST ================');
      console.log(`STATUS:        ACTIVE`);
      console.log(`MARKET ID:     ${opts.marketId}`);
      console.log(`MARKET PDA:    ${marketPda.toBase58()}`);
      console.log(`MINT A (BASE): ${mintA.toBase58()}`);
      console.log(`MINT B (QUOTE):${mintB.toBase58()}`);
      console.log(`LP MINT:       ${lpMintPda.toBase58()}`);
      console.log(`EXPLORER:      https://solscan.io/tx/${initTx}?cluster=devnet`);
      console.log('========================================================\n');

    } catch (err: any) {
      logger.error(`Market launch failed: ${err.message}`);
      if (err.logs) {
        logger.error(`Program Logs: \n${err.logs.join('\n')}`);
      }
      process.exit(1);
    }
  });

program
  .command('trade')
  .description('Perform instant continuous AMM swap on a Daejin market')
  .requiredOption('-m, --market-id <number>', 'Market ID')
  .requiredOption('-a, --amount-in <number>', 'Raw amount in')
  .option('-d, --direction <dir>', 'Swap direction: a2b or b2a', 'a2b')
  .option('-s, --slippage <pct>', 'Allowed slippage percentage (e.g. 0.5)', '0.5')
  .option('-k, --keypair <path>', 'Trader keypair JSON', './keys/operator.json')
  .option('-e, --endpoint <url>', 'Solana RPC endpoint', clusterApiUrl('devnet'))
  .action(async (opts) => {
    try {
      const connection = new Connection(opts.endpoint, 'confirmed');
      const trader = loadKeypair(opts.keypair);
      const wallet = new Wallet(trader);
      const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

      const marketId = new BN(opts.marketId);
      const marketIdBuffer = marketId.toArrayLike(Buffer, 'le', 8);

      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('market'), marketIdBuffer],
        PROGRAM_ID
      );
      const [vaultAPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_a'), marketPda.toBuffer()],
        PROGRAM_ID
      );
      const [vaultBPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_b'), marketPda.toBuffer()],
        PROGRAM_ID
      );

      const idl = (await Program.fetchIdl(PROGRAM_ID, provider))!;
      const daejinProgram = new Program(idl, provider);

      // Fetch market state to acquire mints
      const marketState: any = await daejinProgram.account.marketState.fetch(marketPda);

      const traderTokenA = await getOrCreateAssociatedTokenAccount(connection, trader, marketState.mintA, trader.publicKey);
      const traderTokenB = await getOrCreateAssociatedTokenAccount(connection, trader, marketState.mintB, trader.publicKey);

      const swapAtoB = opts.direction.toLowerCase() === 'a2b';
      const amountIn = new BN(opts.amountIn);
      const minAmountOut = new BN(1); // Production agents use deterministic curve calculation

      logger.info(`Submitting Swap: In=${opts.amountIn}, Direction=${swapAtoB ? 'A -> B' : 'B -> A'}`);

      const tx = await daejinProgram.methods
        .swap(amountIn, minAmountOut, swapAtoB)
        .accounts({
          user: trader.publicKey,
          market: marketPda,
          vaultA: vaultAPda,
          vaultB: vaultBPda,
          userTokenA: traderTokenA.address,
          userTokenB: traderTokenB.address,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      logger.info(`Swap successfully confirmed: ${tx}`);

      await notifier.broadcast({
        marketId: opts.marketId,
        marketAddress: marketPda.toBase58(),
        mintA: marketState.mintA.toBase58(),
        mintB: marketState.mintB.toBase58(),
        action: 'SWAP_EXECUTED',
        txSignature: tx,
        details: {
          direction: opts.direction,
          amountIn: opts.amountIn,
        }
      });
    } catch (err: any) {
      logger.error(`Trade failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);