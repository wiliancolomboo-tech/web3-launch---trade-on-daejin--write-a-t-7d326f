import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { Program, AnchorProvider, Wallet, BN } from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { TwitterApi } from 'twitter-api-v2';
import axios from 'axios';
import * as winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

export interface MarketDeployConfig {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseAmount: bigint;
  quoteAmount: bigint;
  feeBps: number;
}

export class DaejinMarketAgent {
  private connection: Connection;
  private provider: AnchorProvider;
  private program: Program;
  private twitterClient?: TwitterApi;
  private discordWebhookUrl?: string;

  constructor(
    rpcUrl: string,
    keypair: Keypair,
    programId: PublicKey,
    idl: any,
    twitterKeys?: { appKey: string; appSecret: string; accessToken: string; accessSecret: string },
    discordWebhookUrl?: string
  ) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    const wallet = new Wallet(keypair);
    this.provider = new AnchorProvider(this.connection, wallet, { commitment: 'confirmed' });
    this.program = new Program(idl, programId, this.provider);
    this.discordWebhookUrl = discordWebhookUrl;

    if (twitterKeys && twitterKeys.appKey) {
      this.twitterClient = new TwitterApi({
        appKey: twitterKeys.appKey,
        appSecret: twitterKeys.appSecret,
        accessToken: twitterKeys.accessToken,
        accessSecret: twitterKeys.accessSecret,
      });
    }
  }

  public deriveMarketAddress(baseMint: PublicKey, quoteMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('market'), baseMint.toBuffer(), quoteMint.toBuffer()],
      this.program.programId
    );
  }

  public deriveAuthorityAddress(baseMint: PublicKey, quoteMint: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('authority'), baseMint.toBuffer(), quoteMint.toBuffer()],
      this.program.programId
    );
  }

  public async launchAndSeedMarket(config: MarketDeployConfig): Promise<{ txSig: string; marketAddress: PublicKey }> {
    logger.info('Preparing to launch and seed Daejin Market...', { config: { ...config, baseMint: config.baseMint.toBase58() } });

    const [marketPda] = this.deriveMarketAddress(config.baseMint, config.quoteMint);
    const [authorityPda] = this.deriveAuthorityAddress(config.baseMint, config.quoteMint);

    const baseVault = Keypair.generate();
    const quoteVault = Keypair.generate();

    const creatorBaseAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.provider.wallet.payer,
      config.baseMint,
      this.provider.wallet.publicKey
    );

    const creatorQuoteAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.provider.wallet.payer,
      config.quoteMint,
      this.provider.wallet.publicKey
    );

    const txSig = await this.program.methods
      .initializeAndSeedMarket(
        new BN(config.baseAmount.toString()),
        new BN(config.quoteAmount.toString()),
        config.feeBps
      )
      .accounts({
        market: marketPda,
        marketAuthority: authorityPda,
        baseMint: config.baseMint,
        quoteMint: config.quoteMint,
        baseVault: baseVault.publicKey,
        quoteVault: quoteVault.publicKey,
        creator: this.provider.wallet.publicKey,
        creatorBaseAccount: creatorBaseAta.address,
        creatorQuoteAccount: creatorQuoteAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([baseVault, quoteVault])
      .rpc();

    logger.info('Market created successfully on-chain', { txSig, marketAddress: marketPda.toBase58() });

    return { txSig, marketAddress: marketPda };
  }

  public async executeInitialTrade(
    baseMint: PublicKey,
    quoteMint: PublicKey,
    amountIn: bigint,
    minAmountOut: bigint
  ): Promise<string> {
    logger.info('Executing introductory discovery swap...');
    const [marketPda] = this.deriveMarketAddress(baseMint, quoteMint);
    const [authorityPda] = this.deriveAuthorityAddress(baseMint, quoteMint);

    const marketAccount = await this.program.account['marketState'].fetch(marketPda);

    const userBaseAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.provider.wallet.payer,
      baseMint,
      this.provider.wallet.publicKey
    );

    const userQuoteAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.provider.wallet.payer,
      quoteMint,
      this.provider.wallet.publicKey
    );

    const swapTx = await this.program.methods
      .swap(
        new BN(amountIn.toString()),
        new BN(minAmountOut.toString()),
        false // Quote to Base trade
      )
      .accounts({
        market: marketPda,
        marketAuthority: authorityPda,
        baseVault: marketAccount.baseVault,
        quoteVault: marketAccount.quoteVault,
        user: this.provider.wallet.publicKey,
        userBaseAccount: userBaseAta.address,
        userQuoteAccount: userQuoteAta.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    logger.info('Initial trade confirmed', { swapTx });
    return swapTx;
  }

  public async syndicateLaunchSocials(
    tokenSymbol: string,
    marketAddress: PublicKey,
    txSignature: string
  ): Promise<void> {
    const threadTweets = [
      `🚨 LIVE ON @DaejinProtocol: Introducing $${tokenSymbol} liquidity market! 🚀\n\nDirect on-chain AMM liquidity seeded & verified on Solana.\n📍 Market: ${marketAddress.toBase58()}\nTx: https://solscan.io/tx/${txSignature}\n\n1/3 👇`,
      `⚙️ Engine Specs:\n• Constant-Product Invariant AMM\n• Fully Timelocked PDA Vaults\n• Sub-second finality\n\nTrade instantly on Daejin DEX with minimal slippage: https://daejin.trade/market/${marketAddress.toBase58()}\n\n2/3`,
      `🔐 Audited Security:\n• Seeded atomically via CPI\n• Zero pre-allocation sandwich vulnerability\n• Powered by Solana & @DaejinProtocol\n\nDive into the future of decentralized trading: https://daejin.trade\n\n3/3`
    ];

    if (this.twitterClient) {
      try {
        const v2Client = this.twitterClient.v2;
        const postResult = await v2Client.tweetThread(threadTweets);
        logger.info('Twitter thread syndicated successfully', { threadDetails: postResult });
      } catch (err: any) {
        logger.error('Failed to post Twitter thread', { error: err.message });
      }
    } else {
      logger.warn('Twitter API credentials not configured; logging generated thread to console:');
      threadTweets.forEach((t, i) => console.log(`[Tweet ${i + 1}]:\n${t}\n`));
    }

    if (this.discordWebhookUrl) {
      try {
        await axios.post(this.discordWebhookUrl, {
          embeds: [
            {
              title: `🚀 New Daejin Market: $${tokenSymbol}`,
              color: 0x00f0ff,
              fields: [
                { name: 'Market Address', value: `\`${marketAddress.toBase58()}\``, inline: false },
                { name: 'Creation Tx', value: `[Solscan](https://solscan.io/tx/${txSignature})`, inline: true },
                { name: 'Status', value: 'Seeded & Active', inline: true },
              ],
              footer: { text: 'Daejin Automated Market Monitor' },
              timestamp: new Date().toISOString(),
            },
          ],
        });
        logger.info('Discord notification emitted successfully');
      } catch (err: any) {
        logger.error('Failed to publish Discord webhook alert', { error: err.message });
      }
    }
  }
}