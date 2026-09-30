import axios from 'axios';
import { Resend } from 'resend';
import pino from 'pino';

const logger = pino({
  transport: { target: 'pino-pretty' }
});

export interface MarketAlertPayload {
  marketId: string;
  marketAddress: string;
  mintA: string;
  mintB: string;
  action: 'INITIALIZED' | 'LIQUIDITY_ADDED' | 'SWAP_EXECUTED' | 'SETTLED';
  txSignature: string;
  details?: Record<string, any>;
}

export class EnterpriseNotifier {
  private resend: Resend | null = null;
  private discordWebhookUrl: string | null;
  private slackWebhookUrl: string | null;
  private adminEmail: string | null;

  constructor() {
    this.discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL || null;
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || null;
    this.adminEmail = process.env.ADMIN_ALERT_EMAIL || null;
    
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
  }

  async broadcast(payload: MarketAlertPayload): Promise<void> {
    const promises: Promise<any>[] = [];

    const solscanUrl = `https://solscan.io/tx/${payload.txSignature}?cluster=devnet`;
    const message = `🚀 [Daejin Market Engine] Event: ${payload.action}\n` +
      `• Market ID: ${payload.marketId}\n` +
      `• Market Address: ${payload.marketAddress}\n` +
      `• Tx Signature: ${solscanUrl}\n` +
      `• Details: ${JSON.stringify(payload.details || {}, null, 2)}`;

    // 1. Dispatch to Discord
    if (this.discordWebhookUrl) {
      promises.push(
        axios.post(this.discordWebhookUrl, {
          username: 'Daejin Engine Sentinel',
          avatar_url: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
          embeds: [{
            title: `Daejin Protocol Event: ${payload.action}`,
            color: payload.action === 'INITIALIZED' ? 0x00FF88 : 0x3399FF,
            fields: [
              { name: 'Market Address', value: `\`${payload.marketAddress}\``, inline: false },
              { name: 'Base Mint (A)', value: `\`${payload.mintA}\``, inline: true },
              { name: 'Quote Mint (B)', value: `\`${payload.mintB}\``, inline: true },
              { name: 'Solscan Proof', value: `[View on Explorer](${solscanUrl})`, inline: false }
            ],
            footer: { text: 'Daejin Enterprise Liquidity Layer' },
            timestamp: new Date().toISOString()
          }]
        }).catch(err => logger.error(`Discord relay error: ${err.message}`))
      );
    }

    // 2. Dispatch to Slack
    if (this.slackWebhookUrl) {
      promises.push(
        axios.post(this.slackWebhookUrl, {
          text: message
        }).catch(err => logger.error(`Slack relay error: ${err.message}`))
      );
    }

    // 3. Dispatch to Resend Email
    if (this.resend && this.adminEmail) {
      promises.push(
        this.resend.emails.send({
          from: 'alerts@daejin-engine.internal',
          to: this.adminEmail,
          subject: `CRITICAL: Daejin Market Event [${payload.action}]`,
          html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2 style="color: #0b57d0;">Daejin Market Event: ${payload.action}</h2>
            <p><strong>Market Address:</strong> ${payload.marketAddress}</p>
            <p><strong>Market ID:</strong> ${payload.marketId}</p>
            <p><strong>Transaction:</strong> <a href="${solscanUrl}">${payload.txSignature}</a></p>
            <pre style="background: #f4f4f4; padding: 12px; border-radius: 4px;">${JSON.stringify(payload.details, null, 2)}</pre>
          </div>`
        }).catch(err => logger.error(`Resend email error: ${err.message}`))
      );
    }

    await Promise.allSettled(promises);
    logger.info(`Enterprise broadcast delivered for ${payload.action} (${payload.txSignature.slice(0, 8)}...)`);
  }
}