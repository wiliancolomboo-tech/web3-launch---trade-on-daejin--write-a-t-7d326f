use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Daejin1111111111111111111111111111111111111");

#[program]
pub mod daejin_market {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        fee_bps: u16,
        initial_liquidity: u64,
    ) -> Result<()> {
        instructions::init_market::handler(ctx, market_id, fee_bps, initial_liquidity)
    }

    pub fn trade_outcome(
        ctx: Context<TradeOutcome>,
        target_outcome: u8,
        collateral_in: u64,
        min_tokens_out: u64,
    ) -> Result<()> {
        instructions::trade_outcome::handler(ctx, target_outcome, collateral_in, min_tokens_out)
    }

    pub fn resolve_market(ctx: Context<ResolveMarket>, winning_outcome: u8) -> Result<()> {
        instructions::resolve_market::handler(ctx, winning_outcome)
    }

    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        instructions::claim_winnings::handler(ctx)
    }
}