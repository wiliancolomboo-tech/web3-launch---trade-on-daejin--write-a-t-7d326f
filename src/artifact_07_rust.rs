use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use crate::state::{Market, MarketStatus};
use crate::errors::DaejinError;

#[derive(Accounts)]
#[instruction(market_id: u64, fee_bps: u16, initial_liquidity: u64)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// CHECK: Validated as designated resolver
    pub resolver: UncheckedAccount<'info>,

    pub collateral_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        space = Market::LEN,
        seeds = [b"market", creator.key().as_ref(), &market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        init,
        payer = creator,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = collateral_vault
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        seeds = [b"mint_a", market.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market
    )]
    pub outcome_a_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        seeds = [b"mint_b", market.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market
    )]
    pub outcome_b_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = collateral_mint,
        token::authority = creator
    )]
    pub creator_collateral_ata: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeMarket>,
    market_id: u64,
    fee_bps: u16,
    initial_liquidity: u64,
) -> Result<()> {
    require!(initial_liquidity > 0, DaejinError::ZeroAmount);
    require!(fee_bps <= 1000, DaejinError::MathOverflow); // Max 10%

    let market = &mut ctx.accounts.market;
    market.creator = ctx.accounts.creator.key();
    market.resolver = ctx.accounts.resolver.key();
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.outcome_a_mint = ctx.accounts.outcome_a_mint.key();
    market.outcome_b_mint = ctx.accounts.outcome_b_mint.key();
    market.collateral_vault = ctx.accounts.collateral_vault.key();
    market.market_id = market_id;
    market.fee_bps = fee_bps;
    market.pool_collateral = initial_liquidity;
    market.pool_outcome_a = initial_liquidity;
    market.pool_outcome_b = initial_liquidity;
    market.winning_outcome = 0;
    market.status = MarketStatus::Active;
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.collateral_vault;

    // Deposit initial liquidity from creator to vault
    let cpi_accounts = token::Transfer {
        from: ctx.accounts.creator_collateral_ata.to_account_info(),
        to: ctx.accounts.collateral_vault.to_account_info(),
        authority: ctx.accounts.creator.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token::transfer(cpi_ctx, initial_liquidity)?;

    msg!("Daejin Market initialized successfully: ID {}", market_id);
    Ok(())
}