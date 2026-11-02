import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DaejinMarket } from "../target/types/daejin_market";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("daejin_market", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DaejinMarket as Program<DaejinMarket>;

  const payer = (provider.wallet as anchor.Wallet).payer;
  const trader = Keypair.generate();

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let marketPda: PublicKey;
  let baseVaultPda: PublicKey;
  let quoteVaultPda: PublicKey;

  let payerBaseAta: PublicKey;
  let payerQuoteAta: PublicKey;
  let traderBaseAta: PublicKey;
  let traderQuoteAta: PublicKey;

  const INITIAL_BASE = new anchor.BN(1_000_000 * 1e6);
  const INITIAL_QUOTE = new anchor.BN(500_000 * 1e6);

  before(async () => {
    // Airdrop SOL to trader
    const airdropSig = await provider.connection.requestAirdrop(trader.publicKey, 2 * 1e9);
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    // Create Base and Quote Mints
    baseMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    quoteMint = await createMint(provider.connection, payer, payer.publicKey, null, 6);

    // Derive PDA keys
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daejin_market"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    [baseVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daejin_vault"), marketPda.toBuffer(), baseMint.toBuffer()],
      program.programId
    );

    [quoteVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daejin_vault"), marketPda.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    // Setup ATA accounts
    const pBase = await getOrCreateAssociatedTokenAccount(provider.connection, payer, baseMint, payer.publicKey);
    const pQuote = await getOrCreateAssociatedTokenAccount(provider.connection, payer, quoteMint, payer.publicKey);
    payerBaseAta = pBase.address;
    payerQuoteAta = pQuote.address;

    const tBase = await getOrCreateAssociatedTokenAccount(provider.connection, payer, baseMint, trader.publicKey);
    const tQuote = await getOrCreateAssociatedTokenAccount(provider.connection, payer, quoteMint, trader.publicKey);
    traderBaseAta = tBase.address;
    traderQuoteAta = tQuote.address;

    // Mint supplies
    await mintTo(provider.connection, payer, baseMint, payerBaseAta, payer, 2_000_000 * 1e6);
    await mintTo(provider.connection, payer, quoteMint, payerQuoteAta, payer, 1_000_000 * 1e6);
    await mintTo(provider.connection, payer, quoteMint, traderQuoteAta, payer, 10_000 * 1e6);
  });

  it("1. Successfully initializes a Daejin Market with constant product liquidity", async () => {
    const tx = await program.methods
      .initializeMarket(INITIAL_BASE, INITIAL_QUOTE)
      .accounts({
        market: marketPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        creatorBaseAccount: payerBaseAta,
        creatorQuoteAccount: payerQuoteAta,
        creator: payer.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const marketAccount = await program.account.marketState.fetch(marketPda);
    expect(marketAccount.creator.toBase58()).to.equal(payer.publicKey.toBase58());
    expect(marketAccount.baseMint.toBase58()).to.equal(baseMint.toBase58());
    expect(marketAccount.quoteMint.toBase58()).to.equal(quoteMint.toBase58());
    expect(marketAccount.tradeCount.toNumber()).to.equal(0);

    const baseVaultBal = await provider.connection.getTokenAccountBalance(baseVaultPda);
    const quoteVaultBal = await provider.connection.getTokenAccountBalance(quoteVaultPda);
    expect(baseVaultBal.value.amount).to.equal(INITIAL_BASE.toString());
    expect(quoteVaultBal.value.amount).to.equal(INITIAL_QUOTE.toString());
  });

  it("2. Fails to initialize market if deposit is 0", async () => {
    const dummyBase = await createMint(provider.connection, payer, payer.publicKey, null, 6);
    const [dummyMarket] = PublicKey.findProgramAddressSync(
      [Buffer.from("daejin_market"), dummyBase.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );
    const [dummyBaseVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("daejin_vault"), dummyMarket.toBuffer(), dummyBase.toBuffer()],
      program.programId
    );
    const [dummyQuoteVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("daejin_vault"), dummyMarket.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );
    const dBaseAta = await getOrCreateAssociatedTokenAccount(provider.connection, payer, dummyBase, payer.publicKey);

    try {
      await program.methods
        .initializeMarket(new anchor.BN(0), INITIAL_QUOTE)
        .accounts({
          market: dummyMarket,
          baseMint: dummyBase,
          quoteMint: quoteMint,
          baseVault: dummyBaseVault,
          quoteVault: dummyQuoteVault,
          creatorBaseAccount: dBaseAta.address,
          creatorQuoteAccount: payerQuoteAta,
          creator: payer.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("Expected transaction to fail on zero deposit amount.");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ZeroDepositAmount");
    }
  });

  it("3. Executes quote-to-base swap with fee verification", async () => {
    const swapQuoteIn = new anchor.BN(1_000 * 1e6); // 1,000 Quote tokens
    const minBaseOut = new anchor.BN(1_500 * 1e6); // Expected ~1,988 base tokens

    await program.methods
      .executeSwap(swapQuoteIn, minBaseOut, false)
      .accounts({
        market: marketPda,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        userSourceAccount: traderQuoteAta,
        userDestinationAccount: traderBaseAta,
        user: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();

    const traderBaseBalance = await provider.connection.getTokenAccountBalance(traderBaseAta);
    expect(Number(traderBaseBalance.value.amount)).to.be.greaterThan(1_900 * 1e6);

    const marketState = await program.account.marketState.fetch(marketPda);
    expect(marketState.tradeCount.toNumber()).to.equal(1);
    expect(marketState.totalVolumeQuote.toNumber()).to.equal(1_000 * 1e6);
  });

  it("4. Prevents slippage breaches on low minimum output expectations", async () => {
    const swapBaseIn = new anchor.BN(1_000 * 1e6);
    // Unrealistic slippage expectation
    const unachievableQuoteOut = new anchor.BN(50_000 * 1e6);

    try {
      await program.methods
        .executeSwap(swapBaseIn, unachievableQuoteOut, true)
        .accounts({
          market: marketPda,
          baseVault: baseVaultPda,
          quoteVault: quoteVaultPda,
          userSourceAccount: traderBaseAta,
          userDestinationAccount: traderQuoteAta,
          user: trader.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader])
        .rpc();
      expect.fail("Swap should have failed with SlippageExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });
});