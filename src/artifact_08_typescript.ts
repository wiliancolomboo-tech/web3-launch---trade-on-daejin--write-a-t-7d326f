import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import { expect } from 'chai';
import { DaejinEngine } from '../target/types/daejin_engine';

describe('Daejin Market Engine - End-to-End Test Suite', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DaejinEngine as Program<DaejinEngine>;
  const authority = Keypair.generate();
  const trader = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let marketPda: PublicKey;
  let vaultAPda: PublicKey;
  let vaultBPda: PublicKey;
  let lpMintPda: PublicKey;

  let authA: PublicKey;
  let authB: PublicKey;
  let authLp: PublicKey;
  let traderA: PublicKey;
  let traderB: PublicKey;

  const marketId = new anchor.BN(888123);
  const feeBps = 30; // 0.3%

  before(async () => {
    // Airdrop SOL to test participants
    const sig1 = await provider.connection.requestAirdrop(authority.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(trader.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Create Base and Quote Mints
    mintA = await createMint(provider.connection, authority, authority.publicKey, null, 6);
    mintB = await createMint(provider.connection, authority, authority.publicKey, null, 6);

    // Derive PDAs
    const marketIdBuffer = marketId.toArrayLike(Buffer, 'le', 8);
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('market'), marketIdBuffer],
      program.programId
    );
    [vaultAPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_a'), marketPda.toBuffer()],
      program.programId
    );
    [vaultBPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_b'), marketPda.toBuffer()],
      program.programId
    );
    [lpMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('lp_mint'), marketPda.toBuffer()],
      program.programId
    );

    // Initialize Token Accounts
    authA = await createAccount(provider.connection, authority, mintA, authority.publicKey);
    authB = await createAccount(provider.connection, authority, mintB, authority.publicKey);
    authLp = await createAccount(provider.connection, authority, lpMintPda, authority.publicKey);

    traderA = await createAccount(provider.connection, trader, mintA, trader.publicKey);
    traderB = await createAccount(provider.connection, trader, mintB, trader.publicKey);

    // Seed authority balances
    await mintTo(provider.connection, authority, mintA, authA, authority, 1_000_000_000);
    await mintTo(provider.connection, authority, mintB, authB, authority, 1_000_000_000);

    // Seed trader balances
    await mintTo(provider.connection, authority, mintA, traderA, authority, 100_000_000);
    await mintTo(provider.connection, authority, mintB, traderB, authority, 100_000_000);
  });

  it('1. Successfully initializes a new Daejin market', async () => {
    await program.methods
      .initializeMarket(marketId, feeBps)
      .accounts({
        authority: authority.publicKey,
        market: marketPda,
        mintA: mintA,
        mintB: mintB,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        lpMint: lpMintPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const marketState = await program.account.marketState.fetch(marketPda);
    expect(marketState.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(marketState.feeBps).to.equal(feeBps);
    expect(marketState.isSettled).to.be.false;
  });

  it('2. Deposits seed liquidity and receives correct LP tokens', async () => {
    const depositA = new anchor.BN(500_000_000);
    const depositB = new anchor.BN(500_000_000);

    await program.methods
      .depositLiquidity(depositA, depositB, new anchor.BN(1))
      .accounts({
        user: authority.publicKey,
        market: marketPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        lpMint: lpMintPda,
        userTokenA: authA,
        userTokenB: authB,
        userLp: authLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const vaultABalance = await getAccount(provider.connection, vaultAPda);
    const vaultBBalance = await getAccount(provider.connection, vaultBPda);
    const lpBalance = await getAccount(provider.connection, authLp);

    expect(Number(vaultABalance.amount)).to.equal(500_000_000);
    expect(Number(vaultBBalance.amount)).to.equal(500_000_000);
    // sqrt(500000000 * 500000000) = 500000000
    expect(Number(lpBalance.amount)).to.equal(500_000_000);
  });

  it('3. Executes a CPMM swap from Token A to Token B with fee reduction', async () => {
    const amountIn = new anchor.BN(10_000_000); // 10 tokens
    const minAmountOut = new anchor.BN(9_000_000); // Expecting ~9.7 tokens

    const initialTraderB = (await getAccount(provider.connection, traderB)).amount;

    await program.methods
      .swap(amountIn, minAmountOut, true)
      .accounts({
        user: trader.publicKey,
        market: marketPda,
        vaultA: vaultAPda,
        vaultB: vaultBPda,
        userTokenA: traderA,
        userTokenB: traderB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([trader])
      .rpc();

    const finalTraderB = (await getAccount(provider.connection, traderB)).amount;
    const tokensReceived = finalTraderB - initialTraderB;

    expect(Number(tokensReceived)).to.be.greaterThan(9_000_000);
  });

  it('4. Reverts when excessive slippage is demanded', async () => {
    const amountIn = new anchor.BN(1_000_000);
    const impossibleMinOut = new anchor.BN(100_000_000); // Demands impossible execution price

    try {
      await program.methods
        .swap(amountIn, impossibleMinOut, true)
        .accounts({
          user: trader.publicKey,
          market: marketPda,
          vaultA: vaultAPda,
          vaultB: vaultBPda,
          userTokenA: traderA,
          userTokenB: traderB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([trader])
        .rpc();
      expect.fail('Expected transaction to fail due to excessive slippage');
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal('ExcessiveSlippage');
    }
  });

  it('5. Allows market settlement only by designated authority', async () => {
    // Non-authority trader attempts to settle
    try {
      await program.methods
        .settleMarket(1)
        .accounts({
          market: marketPda,
          authority: trader.publicKey,
        })
        .signers([trader])
        .rpc();
      expect.fail('Expected non-authority settlement to fail');
    } catch (err: any) {
      expect(err).to.exist;
    }

    // Authorized operator settles
    await program.methods
      .settleMarket(1)
      .accounts({
        market: marketPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const updatedMarket = await program.account.marketState.fetch(marketPda);
    expect(updatedMarket.isSettled).to.be.true;
    expect(updatedMarket.winningSide).to.equal(1);
  });
});