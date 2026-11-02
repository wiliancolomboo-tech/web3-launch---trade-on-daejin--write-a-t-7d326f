import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DaejinMarket } from "../target/types/daejin_market";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("daejin_market verification test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DaejinMarket as Program<DaejinMarket>;

  let collateralMint: PublicKey;
  let creatorCollateralAta: PublicKey;
  let traderCollateralAta: PublicKey;
  let traderOutcomeAAta: PublicKey;
  let traderOutcomeBAta: PublicKey;

  const creator = provider.wallet as anchor.Wallet;
  const trader = Keypair.generate();
  const resolver = Keypair.generate();

  const marketId = new anchor.BN(90210);
  const initialLiquidity = new anchor.BN(10_000_000); // 10 units with 6 decimals
  const feeBps = 200; // 2%

  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let outcomeAMintPda: PublicKey;
  let outcomeBMintPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test participants
    const airdropSig = await provider.connection.requestAirdrop(
      trader.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create Base Collateral Token (e.g. USDC mock)
    collateralMint = await createMint(
      provider.connection,
      creator.payer,
      creator.publicKey,
      null,
      6
    );

    // Setup Token Accounts
    creatorCollateralAta = await createAccount(
      provider.connection,
      creator.payer,
      collateralMint,
      creator.publicKey
    );

    traderCollateralAta = await createAccount(
      provider.connection,
      creator.payer,
      collateralMint,
      trader.publicKey
    );

    // Mint Collateral balances
    await mintTo(
      provider.connection,
      creator.payer,
      collateralMint,
      creatorCollateralAta,
      creator.publicKey,
      100_000_000
    );

    await mintTo(
      provider.connection,
      creator.payer,
      collateralMint,
      traderCollateralAta,
      creator.publicKey,
      50_000_000
    );

    // Calculate PDAs
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), creator.publicKey.toBuffer(), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );

    [outcomeAMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_a"), marketPda.toBuffer()],
      program.programId
    );

    [outcomeBMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_b"), marketPda.toBuffer()],
      program.programId
    );

    // Setup Trader Outcome Token Accounts
    traderOutcomeAAta = await createAccount(
      provider.connection,
      creator.payer,
      outcomeAMintPda,
      trader.publicKey
    );

    traderOutcomeBAta = await createAccount(
      provider.connection,
      creator.payer,
      outcomeBMintPda,
      trader.publicKey
    );
  });

  it("1. Successfully initializes a new Daejin binary market with escrow liquidity", async () => {
    await program.methods
      .initializeMarket(marketId, feeBps, initialLiquidity)
      .accounts({
        creator: creator.publicKey,
        resolver: resolver.publicKey,
        collateralMint: collateralMint,
        market: marketPda,
        collateralVault: vaultPda,
        outcomeAMint: outcomeAMintPda,
        outcomeBMint: outcomeBMintPda,
        creatorCollateralAta: creatorCollateralAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const marketAccount = await program.account.market.fetch(marketPda);
    expect(marketAccount.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(marketAccount.resolver.toBase58()).to.equal(resolver.publicKey.toBase58());
    expect(marketAccount.marketId.toNumber()).to.equal(marketId.toNumber());
    expect(marketAccount.poolCollateral.toNumber()).to.equal(initialLiquidity.toNumber());

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(initialLiquidity.toNumber());
  });

  it("2. Executes dynamic bonding curve swap for Outcome A tokens", async () => {
    const tradeAmount = new anchor.BN(1_000_000); // 1 USDC
    const minTokensOut = new anchor.BN(100_000);

    await program.methods
      .tradeOutcome(1, tradeAmount, minTokensOut)
      .accounts({
        trader: trader.publicKey,
        market: marketPda,
        traderCollateralAta: traderCollateralAta,
        collateralVault: vaultPda,
        outcomeAMint: outcomeAMintPda,
        outcomeBMint: outcomeBMintPda,
        traderOutcomeAAta: traderOutcomeAAta,
        traderOutcomeBAta: traderOutcomeBAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();

    const traderAAccount = await getAccount(provider.connection, traderOutcomeAAta);
    expect(Number(traderAAccount.amount)).to.be.greaterThan(0);
  });

  it("3. Enforces authorization check on market resolution (rejects non-resolver)", async () => {
    try {
      await program.methods
        .resolveMarket(1)
        .accounts({
          resolver: trader.publicKey, // unauthorized
          market: marketPda,
        })
        .signers([trader])
        .rpc();
      assert.fail("Should have thrown unauthorized resolver error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedResolver");
    }
  });

  it("4. Resolves market to Outcome A by designated resolver authority", async () => {
    await program.methods
      .resolveMarket(1)
      .accounts({
        resolver: resolver.publicKey,
        market: marketPda,
      })
      .signers([resolver])
      .rpc();

    const marketAccount = await program.account.market.fetch(marketPda);
    expect(marketAccount.winningOutcome).to.equal(1);
  });

  it("5. Allows winning outcome token holders to claim proportional collateral escrow", async () => {
    const preClaimBalance = await getAccount(provider.connection, traderCollateralAta);

    await program.methods
      .claimWinnings()
      .accounts({
        user: trader.publicKey,
        market: marketPda,
        collateralVault: vaultPda,
        outcomeAMint: outcomeAMintPda,
        outcomeBMint: outcomeBMintPda,
        userCollateralAta: traderCollateralAta,
        userOutcomeAAta: traderOutcomeAAta,
        userOutcomeBAta: traderOutcomeBAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();

    const postClaimBalance = await getAccount(provider.connection, traderCollateralAta);
    expect(Number(postClaimBalance.amount)).to.be.greaterThan(Number(preClaimBalance.amount));

    // Trader Outcome A balance must be burned to zero
    const outcomeAAccount = await getAccount(provider.connection, traderOutcomeAAta);
    expect(Number(outcomeAAccount.amount)).to.equal(0);
  });
});