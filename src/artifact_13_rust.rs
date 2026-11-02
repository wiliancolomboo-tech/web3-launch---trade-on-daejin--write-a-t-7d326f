use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Daejin1111111111111111111111111111111111111");

#[program]
pub mod daejin_core {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        question: String,
        resolution_timestamp: i64,
    ) -> Result<()> {
        instructions::initialize_market::handler(ctx, market_id, question, resolution_timestamp)
    }

    pub fn provide_liquidity(ctx: Context<ProvideLiquidity>, amount: u64) -> Result<()> {
        instructions::provide_liquidity::handler(ctx, amount)
    }

    pub fn swap(
        ctx: Context<Swap>,
        collateral_in: u64,
        buy_yes: bool,
        min_tokens_out: u64,
    ) -> Result<()> {
        instructions::swap::handler(ctx, collateral_in, buy_yes, min_tokens_out)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome: u8) -> Result<()> {
        instructions::resolve_market::handler(ctx, outcome)
    }

    pub fn redeem_shares(ctx: Context<RedeemShares>, amount_to_redeem: u64) -> Result<()> {
        instructions::redeem_shares::handler(ctx, amount_to_redeem)
    }
}