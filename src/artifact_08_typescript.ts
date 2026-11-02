import { Command } from 'commander';
import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { EnterpriseNotificationService } from './notifier';

dotenv.config();

const PROGRAM_ID = new PublicKey(
    process.env.DAEJIN_PROGRAM_ID || "Daej1nMarketEng1ne11111111111111111111111111"
);

function loadKeypair(path: string): Keypair {
    const raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(raw));
}

const program = new Command();
program
    .name('daejin-cli')
    .description('Enterprise Automation CLI for Launching & Trading on Daejin Solana Markets')
    .version('1.0.0');

program
    .command('launch-market')
    .description('Initialize a new bonding curve market on Daejin')
    .requiredOption('-k, --keypair <path>', 'Path to payer keypair JSON')
    .requiredOption('-b, --base <pubkey>', 'Base Token Mint address')
    .requiredOption('-q, --quote <pubkey>', 'Quote Token Mint address')
    .option('--fee <bps>', 'Fee in basis points', '100') // 1.00%
    .option('--base-amount <amount>', 'Base reserve initial deposit', '1000000000000') // 1,000,000 w/ 6 decimals
    .option('--quote-amount <amount>', 'Quote reserve virtual start', '50000000000') // 50,000 w/ 6 decimals
    .action(async (options) => {
        const keypair = loadKeypair(options.keypair);
        const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'), 'confirmed');
        const wallet = new Wallet(keypair);
        const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

        const baseMint = new PublicKey(options.base);
        const quoteMint = new PublicKey(options.quote);

        const [marketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("daejin_market"), baseMint.toBuffer(), quoteMint.toBuffer()],
            PROGRAM_ID
        );
        const [baseVaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("base_vault"), marketPda.toBuffer()],
            PROGRAM_ID
        );
        const [quoteVaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("quote_vault"), marketPda.toBuffer()],
            PROGRAM_ID
        );

        console.log(`[INFO] Derived Market PDA: ${marketPda.toBase58()}`);
        console.log(`[INFO] Creator: ${keypair.publicKey.toBase58()}`);

        const creatorBaseAta = await getOrCreateAssociatedTokenAccount(
            connection,
            keypair,
            baseMint,
            keypair.publicKey
        );

        // Fetch IDL and build Anchor Program
        const idl = await Program.fetchIdl(PROGRAM_ID, provider);
        if (!idl) throw new Error("IDL not found for Daejin Program on-chain");

        const daejinProgram = new Program(idl, provider);

        const tx = await daejinProgram.methods
            .initializeMarket(
                parseInt(options.fee),
                new BN(options.baseAmount),
                new BN(options.quoteAmount)
            )
            .accounts({
                market: marketPda,
                baseMint,
                quoteMint,
                baseVault: baseVaultPda,
                quoteVault: quoteVaultPda,
                creatorBaseAccount: creatorBaseAta.address,
                creator: keypair.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log(`[SUCCESS] Market created successfully! Signature: ${tx}`);

        const notifier = new EnterpriseNotificationService();
        await notifier.broadcastMarketCreation({
            marketId: marketPda.toBase58(),
            baseMint: baseMint.toBase58(),
            quoteMint: quoteMint.toBase58(),
            creator: keypair.publicKey.toBase58(),
            baseReserve: options.baseAmount,
            quoteReserve: options.quoteAmount,
            txSignature: tx
        });
        console.log(`[INFO] Enterprise Webhooks Dispatched to Discord & Slack.`);
    });

program
    .command('trade')
    .description('Execute a Buy or Sell order on an active Daejin Market')
    .requiredOption('-k, --keypair <path>', 'Path to trader keypair JSON')
    .requiredOption('-m, --market <pubkey>', 'Market PDA')
    .requiredOption('-a, --action <buy|sell>', 'Action: buy or sell')
    .requiredOption('-i, --amount-in <amount>', 'Exact amount of input token')
    .requiredOption('-o, --min-out <amount>', 'Minimum acceptable amount out (slippage protection)')
    .action(async (options) => {
        const keypair = loadKeypair(options.keypair);
        const connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'), 'confirmed');
        const wallet = new Wallet(keypair);
        const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

        const marketPubkey = new PublicKey(options.market);
        const idl = await Program.fetchIdl(PROGRAM_ID, provider);
        if (!idl) throw new Error("IDL not found on-chain");

        const daejinProgram = new Program(idl, provider);
        const marketAccount: any = await daejinProgram.account.marketState.fetch(marketPubkey);

        const traderBaseAta = await getOrCreateAssociatedTokenAccount(
            connection,
            keypair,
            marketAccount.baseMint,
            keypair.publicKey
        );
        const traderQuoteAta = await getOrCreateAssociatedTokenAccount(
            connection,
            keypair,
            marketAccount.quoteMint,
            keypair.publicKey
        );

        let tx: string;
        if (options.action.toLowerCase() === 'buy') {
            console.log(`[INFO] Executing BUY on market ${marketPubkey.toBase58()}...`);
            tx = await daejinProgram.methods
                .buy(new BN(options.amountIn), new BN(options.minOut))
                .accounts({
                    market: marketPubkey,
                    baseVault: marketAccount.baseVault,
                    quoteVault: marketAccount.quoteVault,
                    traderBaseAccount: traderBaseAta.address,
                    traderQuoteAccount: traderQuoteAta.address,
                    trader: keypair.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();
        } else {
            console.log(`[INFO] Executing SELL on market ${marketPubkey.toBase58()}...`);
            tx = await daejinProgram.methods
                .sell(new BN(options.amountIn), new BN(options.minOut))
                .accounts({
                    market: marketPubkey,
                    baseVault: marketAccount.baseVault,
                    quoteVault: marketAccount.quoteVault,
                    traderBaseAccount: traderBaseAta.address,
                    traderQuoteAccount: traderQuoteAta.address,
                    trader: keypair.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .rpc();
        }

        console.log(`[SUCCESS] Swap completed! Transaction Signature: ${tx}`);
    });

program.parse(process.argv);