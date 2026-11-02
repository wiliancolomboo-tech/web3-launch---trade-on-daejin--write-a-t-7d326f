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
import { assert, expect } from "chai";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";

describe("daejin_market e2e protocol tests", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.DaejinMarket as Program<DaejinMarket>;

    let baseMint: PublicKey;
    let quoteMint: PublicKey;
    let creatorBaseAccount: PublicKey;
    let traderBaseAccount: PublicKey;
    let traderQuoteAccount: PublicKey;

    let marketPda: PublicKey;
    let baseVaultPda: PublicKey;
    let quoteVaultPda: PublicKey;

    const trader = Keypair.generate();
    const INITIAL_BASE_SUPPLY = 100_000_000_000; // 100,000 Tokens (6 decimals)
    const INITIAL_BASE_RESERVE = 50_000_000_000;  // 50,000 in Curve
    const INITIAL_QUOTE_RESERVE = 10_000_000_000; // 10,000 USDC (6 decimals)
    const FEE_BPS = 100; // 1%

    before(async () => {
        // Airdrop SOL to Trader & Provider
        const airdropSig = await provider.connection.requestAirdrop(
            trader.publicKey,
            2 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(airdropSig);

        // 1. Create Base and Quote Mints
        baseMint = await createMint(
            provider.connection,
            (provider.wallet as any).payer,
            provider.wallet.publicKey,
            null,
            6
        );

        quoteMint = await createMint(
            provider.connection,
            (provider.wallet as any).payer,
            provider.wallet.publicKey,
            null,
            6
        );

        // 2. Setup Token Accounts
        creatorBaseAccount = await createAccount(
            provider.connection,
            (provider.wallet as any).payer,
            baseMint,
            provider.wallet.publicKey
        );

        traderBaseAccount = await createAccount(
            provider.connection,
            (provider.wallet as any).payer,
            baseMint,
            trader.publicKey
        );

        traderQuoteAccount = await createAccount(
            provider.connection,
            (provider.wallet as any).payer,
            quoteMint,
            trader.publicKey
        );

        // Mint Base tokens to Creator & Quote tokens to Trader
        await mintTo(
            provider.connection,
            (provider.wallet as any).payer,
            baseMint,
            creatorBaseAccount,
            provider.wallet.publicKey,
            INITIAL_BASE_SUPPLY
        );

        await mintTo(
            provider.connection,
            (provider.wallet as any).payer,
            quoteMint,
            traderQuoteAccount,
            provider.wallet.publicKey,
            50_000_000_000 // 50,000 Quote tokens
        );

        // Derive PDAs
        [marketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("daejin_market"), baseMint.toBuffer(), quoteMint.toBuffer()],
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
    });

    it("1. Successfully initializes a Daejin Market with constant product liquidity", async () => {
        await program.methods
            .initializeMarket(
                FEE_BPS,
                new anchor.BN(INITIAL_BASE_RESERVE),
                new anchor.BN(INITIAL_QUOTE_RESERVE)
            )
            .accounts({
                market: marketPda,
                baseMint,
                quoteMint,
                baseVault: baseVaultPda,
                quoteVault: quoteVaultPda,
                creatorBaseAccount,
                creator: provider.wallet.publicKey,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        const marketState = await program.account.marketState.fetch(marketPda);
        assert.equal(marketState.feeBasisPoints, 100);
        assert.equal(marketState.baseReserve.toString(), INITIAL_BASE_RESERVE.toString());
        assert.equal(marketState.quoteReserve.toString(), INITIAL_QUOTE_RESERVE.toString());

        const baseVaultToken = await getAccount(provider.connection, baseVaultPda);
        assert.equal(baseVaultToken.amount.toString(), INITIAL_BASE_RESERVE.toString());
    });

    it("2. Executes a deterministic BUY and validates invariant preservation", async () => {
        const quoteIn = 1_000_000_000; // 1,000 Quote Tokens
        const minBaseExpected = 4_000_000_000; // 4,000 Base Tokens minimum

        await program.methods
            .buy(new anchor.BN(quoteIn), new anchor.BN(minBaseExpected))
            .accounts({
                market: marketPda,
                baseVault: baseVaultPda,
                quoteVault: quoteVaultPda,
                traderBaseAccount,
                traderQuoteAccount,
                trader: trader.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([trader])
            .rpc();

        const traderBaseBal = await getAccount(provider.connection, traderBaseAccount);
        assert.isTrue(Number(traderBaseBal.amount) >= minBaseExpected);

        const marketState = await program.account.marketState.fetch(marketPda);
        assert.equal(marketState.tradeCount.toNumber(), 1);
        assert.equal(marketState.totalVolume.toString(), quoteIn.toString());
    });

    it("3. Reverts when slippage condition is breached", async () => {
        const quoteIn = 500_000_000;
        const unachievableMinBase = 100_000_000_000; // Expecting way more than exists

        try {
            await program.methods
                .buy(new anchor.BN(quoteIn), new anchor.BN(unachievableMinBase))
                .accounts({
                    market: marketPda,
                    baseVault: baseVaultPda,
                    quoteVault: quoteVaultPda,
                    traderBaseAccount,
                    traderQuoteAccount,
                    trader: trader.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([trader])
                .rpc();
            assert.fail("Should have thrown SlippageExceeded");
        } catch (err: any) {
            expect(err.error.errorCode.code).to.equal("SlippageExceeded");
        }
    });

    it("4. Executes a SELL order and returns quote currency to trader", async () => {
        const baseIn = 2_000_000_000; // Sell 2,000 base tokens
        const minQuoteOut = 200_000_000;

        const initialQuoteBal = await getAccount(provider.connection, traderQuoteAccount);

        await program.methods
            .sell(new anchor.BN(baseIn), new anchor.BN(minQuoteOut))
            .accounts({
                market: marketPda,
                baseVault: baseVaultPda,
                quoteVault: quoteVaultPda,
                traderBaseAccount,
                traderQuoteAccount,
                trader: trader.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([trader])
            .rpc();

        const postQuoteBal = await getAccount(provider.connection, traderQuoteAccount);
        assert.isTrue(Number(postQuoteBal.amount) > Number(initialQuoteBal.amount));
    });
});