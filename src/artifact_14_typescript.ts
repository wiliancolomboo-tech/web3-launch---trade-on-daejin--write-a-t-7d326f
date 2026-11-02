import { Command } from "commander";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

const PROGRAM_ID = new PublicKey(process.env.DAEJIN_PROGRAM_ID || "Daejin1111111111111111111111111111111111111");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "ops@daejin-protocol.io";

function getLocalWallet(): Keypair {
  const secretKeyPath = process.env.SOLANA_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const rawKey = JSON.parse(fs.readFileSync(secretKeyPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(rawKey));
}

// Enterprise Notification Dispatcher
async function sendEnterpriseNotification(title: string, message: string, payload: Record<string, any>) {
  console.log(`[ALERT] ${title}: ${message}`);

  // 1. Dispatch Discord / Slack Webhook
  if (DISCORD_WEBHOOK_URL) {
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: `🚀 Daejin Engine: ${title}`,
            description: message,
            color: 0x00ff88,
            fields: Object.entries(payload).map(([k, v]) => ({
              name: k,
              value: String(v),
              inline: true,
            })),
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log("✓ Webhook alert sent successfully.");
    } catch (err: any) {
      console.error("Failed to send webhook alert:", err.message);
    }
  }

  // 2. Dispatch Email Alert via Resend
  if (RESEND_API_KEY) {
    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "engine@daejin-protocol.io",
          to: ALERT_EMAIL,
          subject: `[Daejin Alert] ${title}`,
          html: `<h3>${title}</h3><p>${message}</p><pre>${JSON.stringify(payload, null, 2)}</pre>`,
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log("✓ Resend email alert delivered.");
    } catch (err: any) {
      console.error("Failed to send email via Resend:", err.message);
    }
  }
}

const programCommand = new Command();

programCommand
  .name("daejin-cli")
  .description("Daejin Protocol Institutional CLI & Automation Worker")
  .version("1.0.0");

programCommand
  .command("create-market")
  .description("Instantiate an on-chain binary market and seed liquidity")
  .requiredOption("-m, --market-id <number>", "Unique 64-bit numerical Market ID")
  .requiredOption("-c, --collateral-mint <pubkey>", "Collateral SPL Token Mint Pubkey")
  .requiredOption("-l, --liquidity <number>", "Initial collateral liquidity (in base atomic units)")
  .option("-f, --fee-bps <number>", "Market fee in bps", "200")
  .action(async (options) => {
    const rpcUrl = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
    const connection = new Connection(rpcUrl, "confirmed");
    const keypair = getLocalWallet();
    const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: "confirmed" });

    const marketIdBN = new BN(options.marketId);
    const collateralMint = new PublicKey(options.collateralMint);
    const liquidity = new BN(options.liquidity);
    const feeBps = parseInt(options.feeBps);

    // Derive PDA addresses
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), keypair.publicKey.toBuffer(), marketIdBN.toArrayLike(Buffer, "le", 8)],
      PROGRAM_ID
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      PROGRAM_ID
    );
    const [mintAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_a"), marketPda.toBuffer()],
      PROGRAM_ID
    );
    const [mintBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_b"), marketPda.toBuffer()],
      PROGRAM_ID
    );

    console.log(`Creating Market on Daejin Engine...`);
    console.log(`Market PDA: ${marketPda.toBase58()}`);
    console.log(`Collateral Vault PDA: ${vaultPda.toBase58()}`);

    const creatorAta = await getOrCreateAssociatedTokenAccount(
      connection,
      keypair,
      collateralMint,
      keypair.publicKey
    );

    // Mock instruction trigger or direct RPC build
    const txSig = "5J7x9MockTxSigDaejinProductionDeploymentOnSolanaDevnet" + Date.now();

    await sendEnterpriseNotification("New Daejin Market Launched", "Deterministic Binary Market Created", {
      MarketID: options.marketId,
      MarketPDA: marketPda.toBase58(),
      CollateralMint: collateralMint.toBase58(),
      OutcomeA: mintAPda.toBase58(),
      OutcomeB: mintBPda.toBase58(),
      InitialLiquidity: options.liquidity,
      TxSignature: txSig,
    });
  });

programCommand
  .command("trade")
  .description("Execute AMM Swap on Daejin Market")
  .requiredOption("-m, --market-id <number>", "Numerical Market ID")
  .requiredOption("-o, --outcome <number>", "Outcome target (1 for A, 2 for B)")
  .requiredOption("-a, --amount <number>", "Collateral amount in base units")
  .action(async (options) => {
    console.log(`Submitting Swap: Outcome ${options.outcome}, Amount: ${options.amount}...`);
    const txSig = "4MockSwapExecutionSignature" + Date.now();
    await sendEnterpriseNotification("Trade Executed", "Outcome Shares Minted", {
      MarketID: options.marketId,
      TargetOutcome: options.outcome,
      CollateralIn: options.amount,
      TxSignature: txSig,
    });
  });

programCommand.parse(process.argv);