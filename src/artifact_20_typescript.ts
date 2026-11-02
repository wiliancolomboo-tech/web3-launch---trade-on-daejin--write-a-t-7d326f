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
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";

describe("Daejin Market Core Engine Verification Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DaejinMarket as Program<DaejinMarket>;

  let collateralMint: PublicKey;
  let creator = Keypair.generate();
  let trader = Keypair.generate();
  let oracle = Keypair.generate();
  let unauthorized = Keypair.generate();

  let creatorCollateralAta: PublicKey;
  let traderCollateralAta: PublicKey;
  let traderYesAta: PublicKey;
  let traderNoAta: PublicKey;

  const marketId = new anchor.BN(9942);
  const title = "Will Solana break $500 before Q4 2025?";
  const feeBps = 100; // 1%
  let resolutionTimestamp: anchor.BN;

  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let yesMintPda: PublicKey;
  let noMintPda: PublicKey;

  before(async () => {
    // Fund all keypairs with SOL for gas
    for (const kp of [creator, trader, oracle, unauthorized]) {
      const airdropSig = await provider.connection.requestAirdrop(kp.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(airdropSig, "confirmed");
    }

    // Create Mock Collateral Mint (6 Decimals, like USDC)
    collateralMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      6
    );

    // Setup ATA for trader and mint 1,000 USDC
    traderCollateralAta = await createAccount(
      provider.connection,
      trader,
      collateralMint,
      trader.publicKey
    );

    await mintTo(
      provider.connection,
      creator,
      collateralMint,
      traderCollateralAta,
      creator,
      1_000_000_000 // 1,000 tokens
    );

    // Derive Program Addresses
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daejin_market"), creator.publicKey.toBuffer(), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), marketPda.toBuffer()], program.programId);
    [yesMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("outcome_mint"), marketPda.toBuffer(), Buffer.from([0])],
      program.programId
    );
    [noMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("outcome_mint"), marketPda.toBuffer(), Buffer.from([1])],
      program.programId
    );

    const now = Math.floor(Date.now() / 1000);
    resolutionTimestamp = new anchor.BN(now + 86400); // +24 hours
  });

  it("1. Successfully creates and seeds a new Daejin prediction market", async () => {
    await program.methods
      .createMarket(marketId, title, feeBps, resolutionTimestamp)
      .accounts({
        market: marketPda,
        collateralMint: collateralMint,
        vault: vaultPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        oracle: oracle.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([creator])
      .rpc();

    const marketState = await program.account.market.fetch(marketPda);
    expect(marketState.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(marketState.title).to.equal(title);
    expect(marketState.feeBps).to.equal(100);
    expect(marketState.totalCollateral.toNumber()).to.equal(0);
    expect(marketState.status).to.deep.equal({ active: {} });
  });

  it("2. Prevents creating a duplicate market with identical seeds", async () => {
    try {
      await program.methods
        .createMarket(marketId, title, feeBps, resolutionTimestamp)
        .accounts({
          market: marketPda,
          collateralMint: collateralMint,
          vault: vaultPda,
          yesMint: yesMintPda,
          noMint: noMintPda,
          oracle: oracle.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([creator])
        .rpc();
      expect.fail("Should have thrown account already in use error");
    } catch (err: any) {
      expect(err.toString()).to.include("already in use");
    }
  });

  it("3. Executes a trade buying YES tokens and verifies vault escrow", async () => {
    // Create trader YES ATA
    traderYesAta = await createAccount(provider.connection, trader, yesMintPda, trader.publicKey);
    traderNoAta = await createAccount(provider.connection, trader, noMintPda, trader.publicKey);

    const collateralIn = new anchor.BN(100_000_000); // 100 USDC
    const minTokensOut = new anchor.BN(99_000_000); // 1% fee expected -> 99 tokens

    await program.methods
      .trade(0, collateralIn, minTokensOut) // 0 = YES
      .accounts({
        market: marketPda,
        vault: vaultPda,
        yesMint: yesMintPda,
        noMint: noMintPda,
        traderCollateral: traderCollateralAta,
        traderOutcome: traderYesAta,
        trader: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();

    // Check balances
    const vaultBal = await getAccount(provider.connection, vaultPda);
    const traderYesBal = await getAccount(provider.connection, traderYesAta);

    expect(Number(vaultBal.amount)).to.equal(100_000_000);
    expect(Number(traderYesBal.amount)).to.equal(99_000_000); // 100 minus 1% fee

    const marketState = await program.account.market.fetch(marketPda);
    expect(marketState.yesReserves.toNumber()).to.equal(99_000_000);
    expect(marketState.totalCollateral.toNumber()).to.equal(99_000_000);
  });

  it("4. Fails settlement if caller is NOT the designated oracle", async () => {
    try {
      await program.methods
        .resolveMarket(1) // Outcome 1 = YES wins
        .accounts({
          market: marketPda,
          oracle: unauthorized.publicKey,
        })
        .signers([unauthorized])
        .rpc();
      expect.fail("Should have rejected unauthorized oracle");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedOracle");
    }
  });

  it("5. Settles market successfully via authorized Oracle", async () => {
    await program.methods
      .resolveMarket(1) // Outcome 1 = YES wins
      .accounts({
        market: marketPda,
        oracle: oracle.publicKey,
      })
      .signers([oracle])
      .rpc();

    const marketState = await program.account.market.fetch(marketPda);
    expect(marketState.status).to.deep.equal({ settled: {} });
    expect(marketState.winningOutcome).to.equal(1);
  });

  it("6. Rejects new trades after market has settled", async () => {
    try {
      await program.methods
        .trade(0, new anchor.BN(10_000_000), new anchor.BN(1))
        .accounts({
          market: marketPda,
          vault: vaultPda,
          yesMint: yesMintPda,
          noMint: noMintPda,
          traderCollateral: traderCollateralAta,
          traderOutcome: traderYesAta,
          trader: trader.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader])
        .rpc();
      expect.fail("Should have failed trade on settled market");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MarketNotActive");
    }
  });

  it("7. Redeems winning outcome tokens and distributes vault funds", async () => {
    const traderCollateralBefore = await getAccount(provider.connection, traderCollateralAta);

    await program.methods
      .claim()
      .accounts({
        market: marketPda,
        vault: vaultPda,
        winningMint: yesMintPda,
        userOutcome: traderYesAta,
        userCollateral: traderCollateralAta,
        user: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();

    const traderCollateralAfter = await getAccount(provider.connection, traderCollateralAta);
    const traderYesAfter = await getAccount(provider.connection, traderYesAta);

    // Trader burned 99,000,000 YES tokens and received 99,000,000 USDC
    expect(Number(traderYesAfter.amount)).to.equal(0);
    expect(Number(traderCollateralAfter.amount) - Number(traderCollateralBefore.amount)).to.equal(99_000_000);
  });
});