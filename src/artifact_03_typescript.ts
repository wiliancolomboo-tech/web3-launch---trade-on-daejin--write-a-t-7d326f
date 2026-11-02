import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import * as fs from "fs";
import axios from "axios";

// Interface Definitions
interface WebhookPayload {
  eventType: "MARKET_CREATED" | "TRADE_EXECUTED" | "MARKET_RESOLVED";
  marketId: string;
  marketAddress: string;
  details: Record<string, any>;
  timestamp: string;
}

class NotificationService {
  private discordWebhook?: string;
  private slackWebhook?: string;

  constructor() {
    this.discordWebhook = process.env.DISCORD_WEBHOOK_URL;
    this.slackWebhook = process.env.SLACK_WEBHOOK_URL;
  }

  async broadcast(payload: WebhookPayload): Promise<void> {
    const formattedDate = new Date(payload.timestamp).toUTCString();
    const content = `🚨 **Daejin Engine Event: ${payload.eventType}**\n` +
      `• Market ID: \`${payload.marketId}\`\n` +
      `• Address: \`${payload.marketAddress}\`\n` +
      `• Time: \`${formattedDate}\`\n` +
      `• Data: \`\`\`json\n${JSON.stringify(payload.details, null, 2)}\`\`\``;

    const promises: Promise<any>[] = [];

    if (this.discordWebhook) {
      promises.push(
        axios.post(this.discordWebhook, { content }).catch((e) =>
          console.error("Failed to push Discord alert:", e.message)
        )
      );
    }

    if (this.slackWebhook) {
      promises.push(
        axios.post(this.slackWebhook, { text: content }).catch((e) =>
          console.error("Failed to push Slack alert:", e.message)
        )
      );
    }

    await Promise.allSettled(promises);
  }
}

// CLI Initialization
const program = new Command();
const notifications = new NotificationService();

function loadWallet(keypairPath: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

function getProgram(
  rpcUrl: string,
  keypair: Keypair
): { program: Program; provider: anchor.AnchorProvider } {
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  
  // Minimal IDL schema for client binding
  const idl = JSON.parse(
    fs.readFileSync("./target/idl/daejin_engine.json", "utf-8")
  );
  const programId = new PublicKey(idl.address || "Daej1n1111111111111111111111111111111111111");
  const p = new Program(idl, provider);
  return { program: p, provider };
}

program
  .name("daejin-cli")
  .description("Daejin Protocol Enterprise Market & Trade Automation CLI")
  .version("1.0.0");

// Command: Create Market
program
  .command("create-market")
  .requiredOption("-k, --keypair <path>", "Path to authority keypair JSON")
  .requiredOption("-m, --market-id <id>", "Unique market identifier (max 32 chars)")
  .requiredOption("-q, --question <text>", "Prediction proposition question")
  .requiredOption("-c, --collateral-mint <pubkey>", "Collateral token mint address (e.g. USDC)")
  .option("-f, --fee-bps <number>", "Fee in basis points (e.g. 100 = 1%)", "100")
  .option("-d, --duration-seconds <number>", "Duration until resolution in seconds", "86400")
  .option("-r, --rpc <url>", "Solana RPC URL", "https://api.devnet.solana.com")
  .action(async (options) => {
    try {
      const keypair = loadWallet(options.keypair);
      const { program: p, provider } = getProgram(options.rpc, keypair);

      const marketId = options.marketId;
      const collateralMint = new PublicKey(options.collateralMint);
      const feeBps = parseInt(options.feeBps, 10);
      const now = Math.floor(Date.now() / 1000);
      const resolutionTimestamp = new anchor.BN(now + parseInt(options.durationSeconds, 10));

      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        p.programId
      );

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), marketPda.toBuffer()],
        p.programId
      );

      console.log(`[INFO] Submitting initialize_market transaction...`);
      const txSig = await (p.methods as any)
        .initializeMarket(marketId, options.question, feeBps, resolutionTimestamp)
        .accounts({
          market: marketPda,
          collateralMint,
          vault: vaultPda,
          authority: keypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log(`[SUCCESS] Market initialized! Tx: ${txSig}`);
      console.log(`[INFO] Market PDA: ${marketPda.toBase58()}`);

      await notifications.broadcast({
        eventType: "MARKET_CREATED",
        marketId,
        marketAddress: marketPda.toBase58(),
        details: {
          question: options.question,
          collateralMint: collateralMint.toBase58(),
          resolutionTimestamp: resolutionTimestamp.toNumber(),
          transactionSignature: txSig,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[ERROR] Failed to initialize market:", err);
      process.exit(1);
    }
  });

// Command: Buy Outcome Shares
program
  .command("buy")
  .requiredOption("-k, --keypair <path>", "Path to user keypair JSON")
  .requiredOption("-m, --market-id <id>", "Market identifier")
  .requiredOption("-o, --outcome <YES|NO>", "Outcome selection")
  .requiredOption("-a, --amount <units>", "Collateral amount to spend (in lowest decimals)")
  .option("-r, --rpc <url>", "Solana RPC URL", "https://api.devnet.solana.com")
  .action(async (options) => {
    try {
      const keypair = loadWallet(options.keypair);
      const { program: p } = getProgram(options.rpc, keypair);

      const marketId = options.marketId;
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        p.programId
      );

      const marketAccount = await (p.account as any).market.fetch(marketPda);
      const collateralMint = marketAccount.collateralMint as PublicKey;

      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), marketPda.toBuffer()],
        p.programId
      );

      const [positionPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), marketPda.toBuffer(), keypair.publicKey.toBuffer()],
        p.programId
      );

      const userCollateralAta = await getAssociatedTokenAddress(
        collateralMint,
        keypair.publicKey
      );

      const outcomeArg = options.outcome.toUpperCase() === "YES" ? { yes: {} } : { no: {} };
      const amountBN = new anchor.BN(options.amount);
      const minSharesOut = new anchor.BN(1); // Standard slippage parameter

      console.log(`[INFO] Executing trade on Daejin: ${options.outcome} for ${options.amount}...`);
      const tx = await (p.methods as any)
        .buyShares(outcomeArg, amountBN, minSharesOut)
        .accounts({
          market: marketPda,
          vault: vaultPda,
          userPosition: positionPda,
          userCollateral: userCollateralAta,
          user: keypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      console.log(`[SUCCESS] Shares acquired! Tx: ${tx}`);

      await notifications.broadcast({
        eventType: "TRADE_EXECUTED",
        marketId,
        marketAddress: marketPda.toBase58(),
        details: {
          trader: keypair.publicKey.toBase58(),
          outcome: options.outcome.toUpperCase(),
          amount: options.amount,
          tx,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[ERROR] Failed to execute trade:", err);
      process.exit(1);
    }
  });

// Command: Resolve Market
program
  .command("resolve")
  .requiredOption("-k, --keypair <path>", "Authority keypair JSON")
  .requiredOption("-m, --market-id <id>", "Market identifier")
  .requiredOption("-o, --winning-outcome <YES|NO>", "Declared outcome")
  .option("-r, --rpc <url>", "Solana RPC URL", "https://api.devnet.solana.com")
  .action(async (options) => {
    try {
      const keypair = loadWallet(options.keypair);
      const { program: p } = getProgram(options.rpc, keypair);

      const marketId = options.marketId;
      const [marketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), Buffer.from(marketId)],
        p.programId
      );

      const outcomeArg = options.winningOutcome.toUpperCase() === "YES" ? { yes: {} } : { no: {} };

      const tx = await (p.methods as any)
        .resolveMarket(outcomeArg)
        .accounts({
          market: marketPda,
          authority: keypair.publicKey,
        })
        .rpc();

      console.log(`[SUCCESS] Market ${marketId} settled! Tx: ${tx}`);

      await notifications.broadcast({
        eventType: "MARKET_RESOLVED",
        marketId,
        marketAddress: marketPda.toBase58(),
        details: {
          winner: options.winningOutcome.toUpperCase(),
          tx,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[ERROR] Resolution failed:", err);
      process.exit(1);
    }
  });

program.parse(process.argv);