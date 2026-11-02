import axios from "axios";
import { config } from "../config";

export interface TelemetryPayload {
  marketId: string;
  marketAddress: string;
  title: string;
  resolutionTimestamp: number;
  signature: string;
  creator: string;
}

export class EnterpriseNotifier {
  public static async notifyAll(payload: TelemetryPayload): Promise<void> {
    const promises: Promise<any>[] = [];

    if (config.discordWebhookUrl) {
      const discordBody = {
        embeds: [
          {
            title: "🚀 New Daejin Market Initialized on Solana",
            color: 0x00f0ff,
            fields: [
              { name: "Market Question", value: payload.title, inline: false },
              { name: "Market PDA", value: `\`${payload.marketAddress}\``, inline: true },
              { name: "Market ID", value: payload.marketId, inline: true },
              { name: "Resolves At", value: new Date(payload.resolutionTimestamp * 1000).toISOString(), inline: true },
              { name: "Solana Signature", value: `[Solscan](https://solscan.io/tx/${payload.signature})`, inline: false }
            ],
            footer: { text: "Daejin Autonomous Market Engine • Production Alert" },
            timestamp: new Date().toISOString(),
          },
        ],
      };
      promises.push(axios.post(config.discordWebhookUrl, discordBody).catch((err) => console.error("Discord error:", err.message)));
    }

    if (config.slackWebhookUrl) {
      const slackBody = {
        text: `*🚀 New Daejin Market Launched on Solana*\n*Title:* ${payload.title}\n*Market PDA:* \`${payload.marketAddress}\`\n*Tx:* https://solscan.io/tx/${payload.signature}`,
      };
      promises.push(axios.post(config.slackWebhookUrl, slackBody).catch((err) => console.error("Slack error:", err.message)));
    }

    await Promise.all(promises);
  }
}