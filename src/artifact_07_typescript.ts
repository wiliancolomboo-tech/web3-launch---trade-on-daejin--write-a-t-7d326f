import * as anchor from '@coral-xyz/anchor';
import { Program, BN } from '@coral-xyz/anchor';
import { DaejinMarket } from '../target/types/daejin_market';
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { expect } from 'chai';

describe('daejin_market integration tests', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.DaejinMarket as Program<DaejinMarket>;

  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let creatorBaseAta: PublicKey;
  let creatorQuoteAta: PublicKey;
  let userBaseAta: PublicKey;
  let userQuoteAta: PublicKey;

  let marketPda: PublicKey;
  let authorityPda: PublicKey;
  let baseVaultKp: Keypair;
  let quoteVaultKp: Keypair;

  const user = Keypair.generate();

  const SEED_BASE = 1_000_000_000_000n; // 1,000,000 units
  const SEED_QUOTE = 50_000_000_000n;  // 50,000 units
  const SWAP_AMOUNT_QUOTE = 1_000_000_000n; // 1,000 units

  before(async () => {
    // Airdrop SOL to test accounts
    const airdropSig = await provider.connection.requestAirdrop(user.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig, 'confirmed');

    // Create Base and Quote Mints
    baseMint = await createMint(provider.connection, (provider.wallet as any).payer, provider.wallet.publicKey, null, 6);
    quoteMint = await createMint(provider.connection, (provider.wallet as any).payer, provider.wallet.publicKey, null, 6);

    // Create Token Accounts for Creator
    creatorBaseAta = await createAccount(provider.connection, (provider.wallet as any).payer, baseMint, provider.wallet.publicKey);
    creatorQuoteAta = await createAccount(provider.connection, (provider.wallet as any).payer, quoteMint, provider.wallet.publicKey);

    // Create Token Accounts for User
    userBaseAta = await createAccount(provider.connection, (provider.wallet as any).payer, baseMint, user.publicKey);
    userQuoteAta = await createAccount(provider.connection, (provider.wallet as any).payer, quoteMint, user.publicKey);

    // Mint supply to Creator & User
    await mintTo(provider.connection, (provider.wallet as any).payer, baseMint, creatorBaseAta, provider.wallet.publicKey, SEED_BASE);
    await mintTo(provider.connection, (provider.wallet as any).payer, quoteMint, creatorQuoteAta, provider.wallet.publicKey, SEED_QUOTE);
    await mintTo(provider.connection, (provider.wallet as any).payer, quoteMint, userQuoteAta, provider.wallet.publicKey, SWAP_AMOUNT_QUOTE * 2n);

    // Derive PDAs
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('market'), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );
    [authorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('authority'), baseMint.toBuffer(), quoteMint.toBuffer()],
      program.programId
    );

    baseVaultKp = Keypair.generate();
    quoteVaultKp = Keypair.generate();
  });

  it('Initializes and seeds the Daejin market atomically', async () => {
    const feeBps = 30; // 0.3%

    await program.methods
      .initializeAndSeedMarket(
        new BN(SEED_BASE.toString()),
        new BN(SEED_QUOTE.toString()),
        feeBps
      )
      .accounts({
        market: marketPda,
        marketAuthority: authorityPda,
        baseMint,
        quoteMint,
        baseVault: baseVaultKp.publicKey,
        quoteVault: quoteVaultKp.publicKey,
        creator: provider.wallet.publicKey,
        creatorBaseAccount: creatorBaseAta,
        creatorQuoteAccount: creatorQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([baseVaultKp, quoteVaultKp])
      .rpc();

    const marketState = await program.account.marketState.fetch(marketPda);
    expect(marketState.creator.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(marketState.feeBps).to.equal(30);

    const baseVaultBalance = await getAccount(provider.connection, baseVaultKp.publicKey);
    const quoteVaultBalance = await getAccount(provider.connection, quoteVaultKp.publicKey);

    expect(baseVaultBalance.amount).to.equal(SEED_BASE);
    expect(quoteVaultBalance.amount).to.equal(SEED_QUOTE);
  });

  it('Executes a valid Quote -> Base trade and verifies constant-product invariant', async () => {
    const marketState = await program.account.marketState.fetch(marketPda);

    await program.methods
      .swap(
        new BN(SWAP_AMOUNT_QUOTE.toString()),
        new BN('1'), // 1 token slippage tolerance
        false // Quote to Base
      )
      .accounts({
        market: marketPda,
        marketAuthority: authorityPda,
        baseVault: marketState.baseVault,
        quoteVault: marketState.quoteVault,
        user: user.publicKey,
        userBaseAccount: userBaseAta,
        userQuoteAccount: userQuoteAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userBaseBalance = await getAccount(provider.connection, userBaseAta);
    expect(userBaseBalance.amount).to.be.greaterThan(0n);
  });

  it('Rejects trades exceeding slippage tolerance', async () => {
    const marketState = await program.account.marketState.fetch(marketPda);

    try {
      await program.methods
        .swap(
          new BN(SWAP_AMOUNT_QUOTE.toString()),
          new BN('999999999999999'), // Unrealistic slippage requirement
          false
        )
        .accounts({
          market: marketPda,
          marketAuthority: authorityPda,
          baseVault: marketState.baseVault,
          quoteVault: marketState.quoteVault,
          user: user.publicKey,
          userBaseAccount: userBaseAta,
          userQuoteAccount: userQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      expect.fail('Should have failed due to slippage');
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal('SlippageExceeded');
    }
  });

  it('Rejects re-initialization of the same pair (PDA Collision Protection)', async () => {
    const dummyBase = Keypair.generate();
    const dummyQuote = Keypair.generate();

    try {
      await program.methods
        .initializeAndSeedMarket(new BN(1000), new BN(1000), 30)
        .accounts({
          market: marketPda,
          marketAuthority: authorityPda,
          baseMint,
          quoteMint,
          baseVault: dummyBase.publicKey,
          quoteVault: dummyQuote.publicKey,
          creator: provider.wallet.publicKey,
          creatorBaseAccount: creatorBaseAta,
          creatorQuoteAccount: creatorQuoteAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([dummyBase, dummyQuote])
        .rpc();
      expect.fail('Should have failed with account already in use');
    } catch (err: any) {
      expect(err.toString()).to.include('already in use');
    }
  });
});