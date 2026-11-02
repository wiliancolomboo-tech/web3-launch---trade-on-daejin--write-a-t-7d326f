use anchor_lang::prelude::*;
use crate::state::{Market, MarketStatus};
use crate::errors::DaejinError;

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    pub resolver: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.creator.as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = resolver @ DaejinError::UnauthorizedResolver
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<ResolveMarket>, winning_outcome: u8) -> Result<()> {
    require!(winning_outcome == 1 || winning_outcome == 2, DaejinError::InvalidResolutionOutcome);
    let market = &mut ctx.accounts.market;
    require!(market.status == MarketStatus::Active, DaejinError::MarketAlreadyResolved);

    market.winning_outcome = winning_outcome;
    market.status = MarketStatus::Resolved;

    msg!("Daejin Market ID {} resolved to outcome: {}", market.market_id, winning_outcome);
    Ok(())
}