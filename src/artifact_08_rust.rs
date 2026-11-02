use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use crate::state::{Market, MarketStatus};
use crate::errors::DaejinError;

#[derive(Accounts)]
pub struct TradeOutcome<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.creator.as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = collateral_vault,
        has_one = outcome_a_mint,
        has_one = outcome_b_mint
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        token::mint = market.collateral_mint,
        token::authority = trader
    )]
    pub trader_collateral_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub collateral_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub outcome_a_mint: Account<'info, Mint>,

    #[account(mut)]
    pub outcome_b_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = outcome_a_mint,
        token::authority = trader
    )]
    pub trader_outcome_a_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = outcome_b_mint,
        token::authority = trader
    )]
    pub trader_outcome_b_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(
    ctx: Context<TradeOutcome>,
    target_outcome: u8, // 1 = Buy A, 2 = Buy B
    collateral_in: u64,
    min_tokens_out: u64,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(market.status == MarketStatus::Active, DaejinError::MarketNotActive);
    require!(collateral_in > 0, DaejinError::ZeroAmount);
    require!(target_outcome == 1 || target_outcome == 2, DaejinError::InvalidResolutionOutcome);

    // Calculate fee
    let fee = (collateral_in as u128)
        .checked_mul(market.fee_bps as u128)
        .ok_or(DaejinError::MathOverflow)?
        .checked_div(10000)
        .ok_or(DaejinError::MathOverflow)? as u64;

    let net_collateral = collateral_in
        .checked_sub(fee)
        .ok_or(DaejinError::MathOverflow)?;

    // Calculate AMM swap invariant: k = x * y
    let (pool_in, pool_out) = if target_outcome == 1 {
        (market.pool_outcome_b as u128, market.pool_outcome_a as u128)
    } else {
        (market.pool_outcome_a as u128, market.pool_outcome_b as u128)
    };

    let invariant_k = pool_in.checked_mul(pool_out).ok_or(DaejinError::MathOverflow)?;
    let new_pool_in = pool_in.checked_add(net_collateral as u128).ok_or(DaejinError::MathOverflow)?;
    let new_pool_out = invariant_k.checked_div(new_pool_in).ok_or(DaejinError::MathOverflow)?;
    let tokens_to_mint = (pool_out.checked_sub(new_pool_out).ok_or(DaejinError::MathOverflow)?) as u64;

    require!(tokens_to_mint >= min_tokens_out, DaejinError::SlippageExceeded);

    // Update pool reserves
    if target_outcome == 1 {
        market.pool_outcome_b = market.pool_outcome_b.checked_add(net_collateral).ok_or(DaejinError::MathOverflow)?;
        market.pool_outcome_a = market.pool_outcome_a.checked_sub(tokens_to_mint).ok_or(DaejinError::MathOverflow)?;
    } else {
        market.pool_outcome_a = market.pool_outcome_a.checked_add(net_collateral).ok_or(DaejinError::MathOverflow)?;
        market.pool_outcome_b = market.pool_outcome_b.checked_sub(tokens_to_mint).ok_or(DaejinError::MathOverflow)?;
    }
    market.pool_collateral = market.pool_collateral.checked_add(collateral_in).ok_or(DaejinError::MathOverflow)?;

    // Transfer collateral from trader to collateral vault
    let transfer_collateral_cpi = token::Transfer {
        from: ctx.accounts.trader_collateral_ata.to_account_info(),
        to: ctx.accounts.collateral_vault.to_account_info(),
        authority: ctx.accounts.trader.to_account_info(),
    };
    token::transfer(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), transfer_collateral_cpi),
        collateral_in,
    )?;

    // Mint outcome tokens to trader via PDA signer
    let market_creator = market.creator;
    let market_id_bytes = market.market_id.to_le_bytes();
    let seeds = &[
        b"market",
        market_creator.as_ref(),
        market_id_bytes.as_ref(),
        &[market.bump],
    ];
    let signer = &[&seeds[..]];

    let (mint_account, dest_ata) = if target_outcome == 1 {
        (
            ctx.accounts.outcome_a_mint.to_account_info(),
            ctx.accounts.trader_outcome_a_ata.to_account_info(),
        )
    } else {
        (
            ctx.accounts.outcome_b_mint.to_account_info(),
            ctx.accounts.trader_outcome_b_ata.to_account_info(),
        )
    };

    let mint_cpi = token::MintTo {
        mint: mint_account,
        to: dest_ata,
        authority: market.to_account_info(),
    };
    token::mint_to(
        CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), mint_cpi, signer),
        tokens_to_mint,
    )?;

    msg!("Executed Trade: Minted {} tokens for outcome {}", tokens_to_mint, target_outcome);
    Ok(())
}