use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Daej1nMarketLauncher111111111111111111111111");

pub const MARKET_SEED: &[u8] = b"market";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const FEE_DENOMINATOR: u64 = 10_000; // Basis points (100 bps = 1%)

#[program]
pub mod daejin_market {
    use super::*;

    /// Initializes a new Daejin Market and atomically deposits initial liquidity.
    pub fn initialize_and_seed_market(
        ctx: Context<InitializeAndSeedMarket>,
        base_amount_in: u64,
        quote_amount_in: u64,
        fee_bps: u16,
    ) -> Result<()> {
        require!(base_amount_in > 0, DaejinError::ZeroInitialLiquidity);
        require!(quote_amount_in > 0, DaejinError::ZeroInitialLiquidity);
        require!(fee_bps <= 1000, DaejinError::FeeExceedsMaximum); // Max 10%

        let market = &mut ctx.accounts.market;
        market.creator = ctx.accounts.creator.key();
        market.base_mint = ctx.accounts.base_mint.key();
        market.quote_mint = ctx.accounts.quote_mint.key();
        market.base_vault = ctx.accounts.base_vault.key();
        market.quote_vault = ctx.accounts.quote_vault.key();
        market.fee_bps = fee_bps;
        market.total_base_shares = base_amount_in;
        market.total_quote_shares = quote_amount_in;
        market.bump = ctx.bumps.market;
        market.authority_bump = ctx.bumps.market_authority;
        market.created_at = Clock::get()?.unix_timestamp;

        // Transfer initial base liquidity from creator to market vault
        let cpi_accounts_base = Transfer {
            from: ctx.accounts.creator_base_account.to_account_info(),
            to: ctx.accounts.base_vault.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        };
        let cpi_ctx_base = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_base,
        );
        token::transfer(cpi_ctx_base, base_amount_in)?;

        // Transfer initial quote liquidity from creator to market vault
        let cpi_accounts_quote = Transfer {
            from: ctx.accounts.creator_quote_account.to_account_info(),
            to: ctx.accounts.quote_vault.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        };
        let cpi_ctx_quote = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts_quote,
        );
        token::transfer(cpi_ctx_quote, quote_amount_in)?;

        emit!(MarketCreatedEvent {
            market: market.key(),
            creator: ctx.accounts.creator.key(),
            base_mint: ctx.accounts.base_mint.key(),
            quote_mint: ctx.accounts.quote_mint.key(),
            initial_base_reserve: base_amount_in,
            initial_quote_reserve: quote_amount_in,
            fee_bps,
            timestamp: market.created_at,
        });

        Ok(())
    }

    /// Swaps Base for Quote or Quote for Base using constant product logic (x * y = k).
    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        minimum_amount_out: u64,
        base_to_quote: bool,
    ) -> Result<()> {
        require!(amount_in > 0, DaejinError::ZeroSwapAmount);

        let market = &mut ctx.accounts.market;
        let base_reserve = ctx.accounts.base_vault.amount;
        let quote_reserve = ctx.accounts.quote_vault.amount;

        require!(base_reserve > 0 && quote_reserve > 0, DaejinError::InsufficientLiquidity);

        // Apply fee deduction
        let fee_amount = (amount_in as u128)
            .checked_mul(market.fee_bps as u128)
            .ok_or(DaejinError::MathOverflow)?
            .checked_div(FEE_DENOMINATOR as u128)
            .ok_or(DaejinError::MathOverflow)? as u64;

        let net_amount_in = amount_in
            .checked_sub(fee_amount)
            .ok_or(DaejinError::MathOverflow)?;

        let (amount_out, new_base_reserve, new_quote_reserve) = if base_to_quote {
            // Base In -> Quote Out
            let numerator = (net_amount_in as u128)
                .checked_mul(quote_reserve as u128)
                .ok_or(DaejinError::MathOverflow)?;
            let denominator = (base_reserve as u128)
                .checked_add(net_amount_in as u128)
                .ok_or(DaejinError::MathOverflow)?;
            let out = (numerator / denominator) as u64;
            (out, base_reserve + amount_in, quote_reserve - out)
        } else {
            // Quote In -> Base Out
            let numerator = (net_amount_in as u128)
                .checked_mul(base_reserve as u128)
                .ok_or(DaejinError::MathOverflow)?;
            let denominator = (quote_reserve as u128)
                .checked_add(net_amount_in as u128)
                .ok_or(DaejinError::MathOverflow)?;
            let out = (numerator / denominator) as u64;
            (out, base_reserve - out, quote_reserve + amount_in)
        };

        require!(amount_out >= minimum_amount_out, DaejinError::SlippageExceeded);

        let base_key = market.base_mint;
        let quote_key = market.quote_mint;
        let auth_bump = market.authority_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            AUTHORITY_SEED,
            base_key.as_ref(),
            quote_key.as_ref(),
            &[auth_bump],
        ]];

        if base_to_quote {
            // Transfer user base into vault
            let cpi_transfer_in = Transfer {
                from: ctx.accounts.user_base_account.to_account_info(),
                to: ctx.accounts.base_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            token::transfer(
                CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_transfer_in),
                amount_in,
            )?;

            // Transfer vault quote out to user via PDA signer
            let cpi_transfer_out = Transfer {
                from: ctx.accounts.quote_vault.to_account_info(),
                to: ctx.accounts.user_quote_account.to_account_info(),
                authority: ctx.accounts.market_authority.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_transfer_out,
                    signer_seeds,
                ),
                amount_out,
            )?;
        } else {
            // Transfer user quote into vault
            let cpi_transfer_in = Transfer {
                from: ctx.accounts.user_quote_account.to_account_info(),
                to: ctx.accounts.quote_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            };
            token::transfer(
                CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_transfer_in),
                amount_in,
            )?;

            // Transfer vault base out to user via PDA signer
            let cpi_transfer_out = Transfer {
                from: ctx.accounts.base_vault.to_account_info(),
                to: ctx.accounts.user_base_account.to_account_info(),
                authority: ctx.accounts.market_authority.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_transfer_out,
                    signer_seeds,
                ),
                amount_out,
            )?;
        }

        emit!(SwapExecutedEvent {
            market: market.key(),
            user: ctx.accounts.user.key(),
            base_to_quote,
            amount_in,
            amount_out,
            fee_amount,
            new_base_reserve,
            new_quote_reserve,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeAndSeedMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + MarketState::INIT_SPACE,
        seeds = [MARKET_SEED, base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub market: Account<'info, MarketState>,

    /// CHECK: PDA acting as the token vault authority
    #[account(
        seeds = [AUTHORITY_SEED, base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub market_authority: AccountInfo<'info>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        token::mint = base_mint,
        token::authority = market_authority
    )]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        token::mint = quote_mint,
        token::authority = market_authority
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        token::mint = base_mint,
        token::authority = creator
    )]
    pub creator_base_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = quote_mint,
        token::authority = creator
    )]
    pub creator_quote_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, market.base_mint.as_ref(), market.quote_mint.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, MarketState>,

    /// CHECK: PDA token vault authority
    #[account(
        seeds = [AUTHORITY_SEED, market.base_mint.as_ref(), market.quote_mint.as_ref()],
        bump = market.authority_bump
    )]
    pub market_authority: AccountInfo<'info>,

    #[account(mut, address = market.base_vault)]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(mut, address = market.quote_vault)]
    pub quote_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        token::mint = market.base_mint,
        token::authority = user
    )]
    pub user_base_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = market.quote_mint,
        token::authority = user
    )]
    pub user_quote_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITION
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct MarketState {
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub fee_bps: u16,
    pub total_base_shares: u64,
    pub total_quote_shares: u64,
    pub created_at: i64,
    pub bump: u8,
    pub authority_bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MarketCreatedEvent {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub initial_base_reserve: u64,
    pub initial_quote_reserve: u64,
    pub fee_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct SwapExecutedEvent {
    pub market: Pubkey,
    pub user: Pubkey,
    pub base_to_quote: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee_amount: u64,
    pub new_base_reserve: u64,
    pub new_quote_reserve: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum DaejinError {
    #[msg("Initial liquidity must be greater than zero for both assets")]
    ZeroInitialLiquidity,
    #[msg("Market fee exceeds the maximum allowed threshold (10%)")]
    FeeExceedsMaximum,
    #[msg("Swap input amount cannot be zero")]
    ZeroSwapAmount,
    #[msg("Insufficient pool reserves for swap")]
    InsufficientLiquidity,
    #[msg("Output slippage limit exceeded")]
    SlippageExceeded,
    #[msg("Mathematical calculation overflowed")]
    MathOverflow,
}