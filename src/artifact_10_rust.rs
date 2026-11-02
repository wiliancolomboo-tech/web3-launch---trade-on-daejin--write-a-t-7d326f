use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer};
use crate::state::{Market, MarketStatus};
use crate::errors::DaejinError;

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.creator.as_ref(), &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = collateral_vault,
        has_one = outcome_a_mint,
        has_one = outcome_b_mint
    )]
    pub market: Account<'info, Market>,

    #[account(mut)]
    pub collateral_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub outcome_a_mint: Account<'info, Mint>,

    #[account(mut)]
    pub outcome_b_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = market.collateral_mint,
        token::authority = user
    )]
    pub user_collateral_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = outcome_a_mint,
        token::authority = user
    )]
    pub user_outcome_a_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = outcome_b_mint,
        token::authority = user
    )]
    pub user_outcome_b_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimWinnings>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.status == MarketStatus::Resolved, DaejinError::MarketNotResolved);

    let (winning_token_ata, winning_mint, total_supply) = if market.winning_outcome == 1 {
        (
            &ctx.accounts.user_outcome_a_ata,
            &ctx.accounts.outcome_a_mint,
            ctx.accounts.outcome_a_mint.supply,
        )
    } else {
        (
            &ctx.accounts.user_outcome_b_ata,
            &ctx.accounts.outcome_b_mint,
            ctx.accounts.outcome_b_mint.supply,
        )
    };

    let user_winning_balance = winning_token_ata.amount;
    require!(user_winning_balance > 0, DaejinError::ZeroWinningBalance);

    // Calculate proportional reward from total collateral escrowed in vault
    let vault_balance = ctx.accounts.collateral_vault.amount;
    let reward = (user_winning_balance as u128)
        .checked_mul(vault_balance as u128)
        .ok_or(DaejinError::MathOverflow)?
        .checked_div(total_supply as u128)
        .ok_or(DaejinError::MathOverflow)? as u64;

    // 1. Burn user's winning outcome tokens
    let burn_cpi = Burn {
        mint: winning_mint.to_account_info(),
        from: winning_token_ata.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    token::burn(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), burn_cpi),
        user_winning_balance,
    )?;

    // 2. Transfer collateral payout from vault PDA to user
    let market_key = market.key();
    let vault_seeds = &[
        b"vault",
        market_key.as_ref(),
        &[market.vault_bump],
    ];
    let signer = &[&vault_seeds[..]];

    let payout_cpi = Transfer {
        from: ctx.accounts.collateral_vault.to_account_info(),
        to: ctx.accounts.user_collateral_ata.to_account_info(),
        authority: ctx.accounts.collateral_vault.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), payout_cpi, signer),
        reward,
    )?;

    msg!("Payout released: {} collateral tokens to {}", reward, ctx.accounts.user.key());
    Ok(())
}