import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DaejinCore } from "../target/types/daejin_core";
import { 
  createMint, 
  getOrCreateAssociatedTokenAccount, 
  mintTo, 
  TOKEN_PROGRAM_ID, 
  getAccount 
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("daejin-core comprehensive test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DaejinCore as Program<DaejinCore>;

  let collateralMint: PublicKey;
  let creatorTokenAccount: PublicKey;
  let traderTokenAccount: PublicKey;

  const admin = Keypair.generate();
  const trader = Keypair.generate();
  const oracle = Keypair.generate();

  const marketId = new BN(99001);
  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let positionPda: PublicKey;

  before(async () => {
    // Fund test wallets
    const airdrop1 = await provider.connection.requestAirdrop(admin.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const airdrop2 = await provider.connection.requestAirdrop(trader.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdrop1);
    await provider.connection.confirmTransaction(airdrop2);

    // Create collateral mint
    collateralMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create token accounts
    const creatorAtaObj = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      collateralMint,
      admin.publicKey
    );
    creatorTokenAccount = creatorAtaObj.address;

    const traderAtaObj = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      trader,
      collateralMint,
      trader.publicKey
    );
    traderTokenAccount = traderAtaObj.address;

    // Mint collateral funds
    await mintTo(provider.connection, admin, collateralMint, creatorTokenAccount, admin, 100_000_000);
    await mintTo(provider.connection, admin, collateralMint, traderTokenAccount, admin, 100_000_000);

    // Derive PDAs
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), admin.publicKey.toBuffer(), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), marketPda.toBuffer()],
      program.programId
    );

    [positionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), marketPda.toBuffer(), trader.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes global protocol parameters", async () => {
    const [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    await program.methods
      .initializeGlobal(150) // 1.5% fee
      .accounts({
        config: globalConfigPda,
        admin: admin.publicKey,
        feeReceiver: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(globalConfigPda);
    expect(configAccount.feeBasisPoints).to.equal(150);
    expect(configAccount.superAdmin.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  it("2. Creates a new market with balanced liquidity reserves", async () => {
    const title = "Will Solana TPS exceed 10,000 before Q4 2025?";
    const outcomeA = "YES";
    const outcomeB = "NO";
    const now = Math.floor(Date.now() / 1000);
    const resolutionTimestamp = new BN(now + 86400 * 30); // 30 days
    const initialLiqA = new BN(10_000_000);
    const initialLiqB = new BN(10_000_000);

    await program.methods
      .createMarket(
        marketId,
        title,
        outcomeA,
        outcomeB,
        resolutionTimestamp,
        initialLiqA,
        initialLiqB
      )
      .accounts({
        market: marketPda,
        vault: vaultPda,
        collateralMint,
        creatorTokenAccount,
        oracleAuthority: oracle.publicKey,
        creator: admin.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const marketAcc = await program.account.market.fetch(marketPda);
    expect(marketAcc.title).to.equal(title);
    expect(marketAcc.totalCollateral.toNumber()).to.equal(20_000_000);
    expect(marketAcc.poolAShares.toNumber()).to.equal(10_000_000);
    expect(marketAcc.poolBShares.toNumber()).to.equal(10_000_000);

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(20_000_000);
  });

  it("3. Executes swap trade against Outcome A and updates reserves correctly", async () => {
    const amountIn = new BN(2_000_000);
    const minSharesOut = new BN(1_500_000);

    await program.methods
      .trade(0, amountIn, minSharesOut)
      .accounts({
        market: marketPda,
        vault: vaultPda,
        position: positionPda,
        traderTokenAccount,
        trader: trader.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([trader])
      .rpc();

    const positionAcc = await program.account.userPosition.fetch(positionPda);
    expect(positionAcc.outcomeAShares.toNumber()).to.be.greaterThan(0);

    const marketAcc = await program.account.market.fetch(marketPda);
    expect(marketAcc.totalCollateral.toNumber()).to.equal(22_000_000);
    expect(marketAcc.poolAShares.toNumber()).to.equal(12_000_000);
  });

  it("4. Rejects trades exceeding user slippage bounds", async () => {
    const amountIn = new BN(1_000_000);
    const unrealisticMinShares = new BN(50_000_000); // Impossible return

    try {
      await program.methods
        .trade(0, amountIn, unrealisticMinShares)
        .accounts({
          market: marketPda,
          vault: vaultPda,
          position: positionPda,
          traderTokenAccount,
          trader: trader.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();
      expect.fail("Trade should have failed due to slippage bounds");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });

  it("5. Prevents market resolution by unauthorized accounts", async () => {
    const impostor = Keypair.generate();
    try {
      await program.methods
        .resolveMarket(0)
        .accounts({
          market: marketPda,
          oracleAuthority: impostor.publicKey,
        })
        .signers([impostor])
        .rpc();
      expect.fail("Resolution should have failed with unauthorized oracle");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedOracle");
    }
  });
});