import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import axios from "axios";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "Daej1nMarket11111111111111111111111111111111"
);
const MARKET_SEED = Buffer.from("daejin_market");
const AUTHORITY_SEED = Buffer.from("daejin_authority");

export interface WebhookNotification {
  event: string;
  marketId: string;
  baseMint: string;
  quoteMint: string;
  txHash: string;
  details: Record<string, any>;
}

export class DaejinEnterpriseClient {
  private connection: Connection;
  private authority: Keypair;
  private program: Program;
  private webhookUrl: string | undefined;

  constructor(rpcUrl: string, secretKeyPath: string, webhookUrl?: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
    const rawKey = JSON.parse(fs.readFileSync(secretKeyPath, "utf-8"));
    this.authority = Keypair.fromSecretKey(Uint8Array.from(rawKey));
    this.webhookUrl = webhookUrl || process.env.ENTERPRISE_WEBHOOK_URL;

    const wallet = new anchor.Wallet(this.authority);
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    
    // Load compiled IDL dynamically or directly
    const idlPath = "./target/idl/daejin_market.json";
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8")) as Idl;
    this.program = new Program(idl, PROGRAM_ID, provider);
  }

  public async notifyEnterpriseChannel(payload: WebhookNotification): Promise<void> {
    if (!this.webhookUrl) {
      console.log("[TELEMETRY - LOCAL] Webhook payload:", JSON.stringify(payload, null, 2));
      return;
    }

    try {
      await axios.post(this.webhookUrl, {
        username: "Daejin Market Daemon",
        embeds: [
          {
            title: `Protocol Event: ${payload.event}`,
            color: payload.event === "MarketCreated" ? 0x00ff7f : 0x00bfff,
            fields: [
              { name: "Market ID", value: payload.marketId, inline: true },
              { name: "Transaction Hash", value: `[Solana Explorer](https://explorer.solana.com/tx/${payload.txHash}?cluster=custom)`, inline: false },
              { name: "Base Mint", value: payload.baseMint, inline: true },
              { name: "Quote Mint", value: payload.quoteMint, inline: true },
              { name: "Telemetry Details", value: JSON.stringify(payload.details, null, 2), inline: false },
            ],
            footer: { text: "Daejin Institutional AMM Engine" },
            timestamp: new Date().toISOString(),
          },
        ],
      });
      console.log(`[TELEMETRY] Enterprise webhook delivered successfully: ${payload.event}`);
    } catch (err: any) {
      console.error(`[TELEMETRY ERROR] Webhook failed to deliver: ${err.message}`);
    }
  }

  public async createAndSeedMarket(
    marketId: anchor.BN,
    feeBps: number,
    initialBase: bigint,
    initialQuote: bigint
  ): Promise<{ marketPda: PublicKey; txHash: string }> {
    console.log(`\n--- Initializing New Daejin Market (ID: ${marketId.toString()}) ---`);

    // 1. Create Base & Quote Mints
    const baseMint = await createMint(
      this.connection,
      this.authority,
      this.authority.publicKey,
      null,
      9
    );
    const quoteMint = await createMint(
      this.connection,
      this.authority,
      this.authority.publicKey,
      null,
      6
    );

    console.log(`Created Base Mint : ${baseMint.toBase58()}`);
    console.log(`Created Quote Mint: ${quoteMint.toBase58()}`);

    // 2. Fund Creator Token Accounts
    const creatorBaseAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.authority,
      baseMint,
      this.authority.publicKey
    );
    const creatorQuoteAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.authority,
      quoteMint,
      this.authority.publicKey
    );

    await mintTo(
      this.connection,
      this.authority,
      baseMint,
      creatorBaseAta.address,
      this.authority,
      initialBase * 2n
    );
    await mintTo(
      this.connection,
      this.authority,
      quoteMint,
      creatorQuoteAta.address,
      this.authority,
      initialQuote * 2n
    );

    // 3. Derive PDA addresses
    const marketIdBuffer = marketId.toArrayLike(Buffer, "le", 8);
    const [marketPda] = PublicKey.findProgramAddressSync(
      [MARKET_SEED, marketIdBuffer],
      this.program.programId
    );
    const [marketAuthorityPda] = PublicKey.findProgramAddressSync(
      [AUTHORITY_SEED, marketIdBuffer],
      this.program.programId
    );

    // 4. Generate Vault Keypairs
    const baseVaultKeypair = Keypair.generate();
    const quoteVaultKeypair = Keypair.generate();

    // 5. Submit Transaction
    const tx = await this.program.methods
      .initializeMarket(
        marketId,
        new anchor.BN(feeBps),
        new anchor.BN(initialBase.toString()),
        new anchor.BN(initialQuote.toString())
      )
      .accounts({
        market: marketPda,
        marketAuthority: marketAuthorityPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        baseVault: baseVaultKeypair.publicKey,
        quoteVault: quoteVaultKeypair.publicKey,
        creator: this.authority.publicKey,
        creatorBaseAccount: creatorBaseAta.address,
        creatorQuoteAccount: creatorQuoteAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([this.authority, baseVaultKeypair, quoteVaultKeypair])
      .rpc();

    console.log(`Market Created Successfully! Transaction: ${tx}`);
    console.log(`Market PDA: ${marketPda.toBase58()}`);

    await this.notifyEnterpriseChannel({
      event: "MarketCreated",
      marketId: marketId.toString(),
      baseMint: baseMint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      txHash: tx,
      details: {
        initialBase: initialBase.toString(),
        initialQuote: initialQuote.toString(),
        feeBps,
        marketPda: marketPda.toBase58(),
      },
    });

    return { marketPda, txHash: tx };
  }

  public async executeTrade(
    marketId: anchor.BN,
    amountIn: bigint,
    minimumAmountOut: bigint,
    isBuy: boolean
  ): Promise<string> {
    console.log(`\n--- Executing Trade on Market ${marketId.toString()} (${isBuy ? "BUY" : "SELL"}) ---`);

    const marketIdBuffer = marketId.toArrayLike(Buffer, "le", 8);
    const [marketPda] = PublicKey.findProgramAddressSync(
      [MARKET_SEED, marketIdBuffer],
      this.program.programId
    );
    const [marketAuthorityPda] = PublicKey.findProgramAddressSync(
      [AUTHORITY_SEED, marketIdBuffer],
      this.program.programId
    );

    const marketAccount = await this.program.account.marketState.fetch(marketPda);

    const userBaseAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.authority,
      marketAccount.baseMint,
      this.authority.publicKey
    );
    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.authority,
      marketAccount.quoteMint,
      this.authority.publicKey
    );

    const tx = await this.program.methods
      .swap(
        new anchor.BN(amountIn.toString()),
        new anchor.BN(minimumAmountOut.toString()),
        isBuy
      )
      .accounts({
        market: marketPda,
        marketAuthority: marketAuthorityPda,
        baseVault: marketAccount.baseVault,
        quoteVault: marketAccount.quoteVault,
        trader: this.authority.publicKey,
        userBaseAccount: userBaseAta.address,
        userQuoteAccount: userQuoteAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([this.authority])
      .rpc();

    console.log(`Swap Executed. Tx Signature: ${tx}`);

    await this.notifyEnterpriseChannel({
      event: "SwapExecuted",
      marketId: marketId.toString(),
      baseMint: marketAccount.baseMint.toBase58(),
      quoteMint: marketAccount.quoteMint.toBase58(),
      txHash: tx,
      details: {
        isBuy,
        amountIn: amountIn.toString(),
        minimumAmountOut: minimumAmountOut.toString(),
      },
    });

    return tx;
  }
}

// Interactive CLI Trigger
async function main() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
  const keypairPath = process.env.WALLET_KEYPAIR_PATH || `${process.env.HOME}/.config/solana/id.json`;
  const webhookUrl = process.env.ENTERPRISE_WEBHOOK_URL;

  const client = new DaejinEnterpriseClient(rpcUrl, keypairPath, webhookUrl);

  const marketId = new anchor.BN(Date.now());
  const initialBase = 1_000_000_000_000n; // 1,000 Base Units (9 decimals)
  const initialQuote = 10_000_000_000n;   // 10,000 Quote Units (6 decimals)
  const feeBps = 30; // 0.30%

  const { txHash } = await client.createAndSeedMarket(marketId, feeBps, initialBase, initialQuote);

  // Execute a test buy swap of 100 Quote tokens
  const amountToSwap = 100_000_000n;
  await client.executeTrade(marketId, amountToSwap, 1n, true);

  console.log("\n[SUCCESS] End-to-end Market Launch & Trade completed seamlessly.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[FATAL ERROR]", err);
    process.exit(1);
  });
}