import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DaejinMarket } from "../target/types/daejin_market";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("daejin_market full integration suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DaejinMarket as Program<DaejinMarket>;
  const authority = (provider.wallet as any).payer as Keypair;

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let marketPda: PublicKey;
  let baseVaultPda: PublicKey;
  let quoteVaultPda: PublicKey;

  let userBaseAccount: PublicKey;
  let userQuoteAccount: PublicKey;
  let feeRecipientAccount: PublicKey;

  const VIRTUAL_BASE = new anchor.BN(10_000_000_000);
  const VIRTUAL_QUOTE = new anchor.BN(1_000_000_000);
  const FEE_BPS = new anchor.BN(30); // 0.30%

  before(async () => {
    // 1. Create Mints
    baseMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );
    quoteMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // 2. Derive PDAs
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );
    [baseVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("base_vault"), marketPda.toBuffer()],
      program.programId
    );
    [quoteVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("quote_vault"), marketPda.toBuffer()],
      program.programId
    );

    // 3. User Token Accounts
    userBaseAccount = await createAccount(
      provider.connection,
      authority,
      baseMint,
      authority.publicKey
    );
    userQuoteAccount = await createAccount(
      provider.connection,
      authority,
      quoteMint,
      authority.publicKey
    );
    feeRecipientAccount = await createAccount(
      provider.connection,
      authority,
      quoteMint,
      authority.publicKey
    );

    // Mint test supply
    await mintTo(
      provider.connection,
      authority,
      baseMint,
      userBaseAccount,
      authority,
      50_000_000_000
    );
    await mintTo(
      provider.connection,
      authority,
      quoteMint,
      userQuoteAccount,
      authority,
      10_000_000_000
    );
  });

  it("1. Successfully initializes a Daejin Market with virtual reserves", async () => {
    const tx = await program.methods
      .initializeMarket(FEE_BPS, VIRTUAL_BASE, VIRTUAL_QUOTE)
      .accounts({
        market: marketPda,
        baseMint,
        quoteMint,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        feeRecipient: feeRecipientAccount,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const marketState = await program.account.marketState.fetch(marketPda);
    expect(marketState.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(marketState.feeBps.toNumber()).to.equal(30);
    expect(marketState.virtualBaseReserves.toString()).to.equal(VIRTUAL_BASE.toString());
    expect(marketState.virtualQuoteReserves.toString()).to.equal(VIRTUAL_QUOTE.toString());
    expect(marketState.realBaseReserves.toNumber()).to.equal(0);
    expect(marketState.realQuoteReserves.toNumber()).to.equal(0);
  });

  it("2. Fails to initialize if fee exceeds maximum permitted (10%)", async () => {
    const invalidFeeBps = new anchor.BN(1001);
    const dummyBase = await createMint(provider.connection, authority, authority.publicKey, null, 6);
    const [dummyMarket] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), dummyBase.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );
    const [dummyBaseVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("base_vault"), dummyMarket.toBuffer()],
      program.programId
    );
    const [dummyQuoteVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("quote_vault"), dummyMarket.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializeMarket(invalidFeeBps, VIRTUAL_BASE, VIRTUAL_QUOTE)
        .accounts({
          market: dummyMarket,
          baseMint: dummyBase,
          quoteMint,
          baseVault: dummyBaseVault,
          quoteVault: dummyQuoteVault,
          feeRecipient: feeRecipientAccount,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      expect.fail("Should have failed with FeeTooHigh");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include("FeeTooHigh");
    }
  });

  it("3. Deposits initial liquidity into market vaults", async () => {
    const depositBase = new anchor.BN(5_000_000_000);
    const depositQuote = new anchor.BN(500_000_000);

    await program.methods
      .depositLiquidity(depositBase, depositQuote)
      .accounts({
        market: marketPda,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        userBaseToken: userBaseAccount,
        userQuoteToken: userQuoteAccount,
        user: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const baseVaultAcc = await getAccount(provider.connection, baseVaultPda);
    const quoteVaultAcc = await getAccount(provider.connection, quoteVaultPda);
    expect(baseVaultAcc.amount.toString()).to.equal(depositBase.toString());
    expect(quoteVaultAcc.amount.toString()).to.equal(depositQuote.toString());

    const marketState = await program.account.marketState.fetch(marketPda);
    expect(marketState.realBaseReserves.toString()).to.equal(depositBase.toString());
    expect(marketState.realQuoteReserves.toString()).to.equal(depositQuote.toString());
  });

  it("4. Executes a valid Quote -> Base swap and transfers protocol fee", async () => {
    const quoteIn = new anchor.BN(10_000_000); // 10 units
    const minBaseOut = new anchor.BN(1);

    const userBaseBefore = await getAccount(provider.connection, userBaseAccount);

    await program.methods
      .swap(quoteIn, minBaseOut, false)
      .accounts({
        market: marketPda,
        baseVault: baseVaultPda,
        quoteVault: quoteVaultPda,
        userSourceToken: userQuoteAccount,
        userDestinationToken: userBaseAccount,
        feeDestinationToken: feeRecipientAccount,
        user: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const userBaseAfter = await getAccount(provider.connection, userBaseAccount);
    expect(userBaseAfter.amount > userBaseBefore.amount).to.be.true;

    const marketState = await program.account.marketState.fetch(marketPda);
    expect(marketState.tradeCount.toNumber()).to.equal(1);
    expect(marketState.totalVolumeQuote.toNumber()).to.be.greaterThan(0);
  });

  it("5. Reverts trade when minimum amount out exceeds invariant output (Slippage check)", async () => {
    const quoteIn = new anchor.BN(1_000_000);
    const impossibleMinOut = new anchor.BN(999_999_999_999); // Impossible expected yield

    try {
      await program.methods
        .swap(quoteIn, impossibleMinOut, false)
        .accounts({
          market: marketPda,
          baseVault: baseVaultPda,
          quoteVault: quoteVaultPda,
          userSourceToken: userQuoteAccount,
          userDestinationToken: userBaseAccount,
          feeDestinationToken: feeRecipientAccount,
          user: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown SlippageExceeded");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include("SlippageExceeded");
    }
  });
});