use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::ProtocolConfig;

declare_id!("DaejinMkt11111111111111111111111111111111111");

#[program]
pub mod daejin_market {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_recipient: Pubkey,
        default_fee_bps: u16,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.fee_recipient = fee_recipient;
        config.default_fee_bps = default_fee_bps;
        config.is_paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        name: String,
        symbol: String,
        uri: String,
        virtual_base: u64,
        virtual_quote: u64,
        initial_base_deposit: u64,
    ) -> Result<()> {
        instructions::initialize_market::handler(
            ctx,
            market_id,
            name,
            symbol,
            uri,
            virtual_base,
            virtual_quote,
            initial_base_deposit,
        )
    }

    pub fn execute_swap(
        ctx: Context<ExecuteSwap>,
        is_buy: bool,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::swap::handler(ctx, is_buy, amount_in, min_amount_out)
    }

    pub fn settle_market(ctx: Context<SettleMarket>, final_price: u64) -> Result<()> {
        instructions::settle_market::handler(ctx, final_price)
    }
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = ProtocolConfig::LEN,
        seeds = [b"protocol_config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}