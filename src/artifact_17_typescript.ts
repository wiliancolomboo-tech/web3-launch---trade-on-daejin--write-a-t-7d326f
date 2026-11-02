import { TwitterApi } from "twitter-api-v2";
import { config } from "../config";

export class TwitterRelayService {
  private client: TwitterApi | null = null;

  constructor() {
    if (config.twitter.appKey && config.twitter.accessToken) {
      this.client = new TwitterApi({
        appKey: config.twitter.appKey,
        appSecret: config.twitter.appSecret,
        accessToken: config.twitter.accessToken,
        accessSecret: config.twitter.accessSecret,
      });
    }
  }

  public async publishLaunchThread(
    marketTitle: string,
    marketAddress: string,
    txSignature: string,
    marketUrl: string
  ): Promise<string[]> {
    if (!this.client) {
      console.warn("⚠️ Twitter credentials missing. Skipping social syndication.");
      return [];
    }

    const rwClient = this.client.readWrite;

    const tweet1 = `🚀 Just launched a new high-speed prediction market on @Daejin Protocol on @solana!\n\n📊 Market: "${marketTitle}"\n\nTrade YES or NO with sub-second finality and guaranteed on-chain escrow vaults. 🧵👇`;
    const tweet2 = `⚡ System Mechanics & On-Chain Verification:\n\n• Program: Daejin Core Anchor Engine\n• Collateral: USDC Single-Vault Escrow\n• Proof: https://solscan.io/tx/${txSignature}\n• Market PDA: ${marketAddress}`;
    const tweet3 = `🌐 Liquid trading is now LIVE.\n\nTake your position or seed automated liquidity on @Daejin today:\n👉 ${marketUrl}\n\n#Solana #DeFi #Daejin #PredictionMarkets $SOL`;

    try {
      const thread = await rwClient.v2.tweetThread([tweet1, tweet2, tweet3]);
      console.log("✅ Twitter thread successfully syndicated. Tweets count:", thread.length);
      return thread.map((t) => t.data.id);
    } catch (err: any) {
      console.error("❌ Failed to broadcast Twitter thread:", err?.data || err.message);
      return [];
    }
  }
}