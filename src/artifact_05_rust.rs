use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Daej1nMarketEng1ne11111111111111111111111111");

#[program]
pub mod daejin_market {
    use super::*;

    /// Initializes a new high-frequency market with deterministic bonding reserves.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fee_basis_points: u16,
        initial_base_reserve: u64,
        initial_quote_reserve: u64,
    ) -> Result<()> {
        require!(fee_basis_points <= 1000, DaejinError::FeeTooHigh); // Max 10%
        require!(initial_base_reserve > 0, DaejinError::ZeroReserve);
        require!(initial_quote_reserve > 0, DaejinError::ZeroReserve);

        let market = &mut ctx.accounts.market;
        market.creator = ctx.accounts.creator.key();
        market.base_mint = ctx.accounts.base_mint.key();
        market.quote_mint = ctx.accounts.quote_mint.key();
        market.base_vault = ctx.accounts.base_vault.key();
        market.quote_vault = ctx.accounts.quote_vault.key();
        market.fee_basis_points = fee_basis_points;
        market.base_reserve = initial_base_reserve;
        market.quote_reserve = initial_quote_reserve;
        market.bump = ctx.bumps.market;
        market.total_volume = 0;
        market.trade_count = 0;

        // Seed initial base token liquidity into the vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.creator_base_account.to_account_info(),
            to: ctx.accounts.base_vault.to_account_info(),
            authority: ctx.accounts.creator.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, initial_base_reserve)?;

        emit!(MarketInitializedEvent {
            market: market.key(),
            creator: market.creator,
            base_mint: market.base_mint,
            quote_mint: market.quote_mint,
            base_reserve: initial_base_reserve,
            quote_reserve: initial_quote_reserve,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Swaps Quote tokens (e.g. USDC/SOL) for Base tokens using Constant Product formula.
    pub fn buy(ctx: Context<Trade>, quote_amount_in: u64, min_base_amount_out: u64) -> Result<()> {
        require!(quote_amount_in > 0, DaejinError::ZeroAmount);

        let market = &mut ctx.accounts.market;
        let fee_bps = market.fee_basis_points as u128;
        
        let quote_in = quote_amount_in as u128;
        let fee_amount = quote_in
            .checked_mul(fee_bps)
            .ok_or(DaejinError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(DaejinError::MathOverflow)?;
        
        let net_quote_in = quote_in
            .checked_sub(fee_amount)
            .ok_or(DaejinError::MathOverflow)?;

        let base_reserve = market.base_reserve as u128;
        let quote_reserve = market.quote_reserve as u128;

        // Constant Product Invariant: dy = (y * dx) / (x + dx)
        let numerator = base_reserve
            .checked_mul(net_quote_in)
            .ok_or(DaejinError::MathOverflow)?;
        let denominator = quote_reserve
            .checked_add(net_quote_in)
            .ok_or(DaejinError::MathOverflow)?;
        let base_out = (numerator.checked_div(denominator).ok_or(DaejinError::MathOverflow)?) as u64;

        require!(base_out >= min_base_amount_out, DaejinError::SlippageExceeded);
        require!(base_out < market.base_reserve, DaejinError::InsufficientReserve);

        // Update state accounts
        market.quote_reserve = market
            .quote_reserve
            .checked_add(quote_amount_in)
            .ok_or(DaejinError::MathOverflow)?;
        market.base_reserve = market
            .base_reserve
            .checked_sub(base_out)
            .ok_or(DaejinError::MathOverflow)?;
        market.total_volume = market
            .total_volume
            .checked_add(quote_amount_in)
            .ok_or(DaejinError::MathOverflow)?;
        market.trade_count = market.trade_count.checked_add(1).ok_or(DaejinError::MathOverflow)?;

        // 1. Transfer quote tokens from trader to quote_vault
        let cpi_quote_accounts = Transfer {
            from: ctx.accounts.trader_quote_account.to_account_info(),
            to: ctx.accounts.quote_vault.to_account_info(),
            authority: ctx.accounts.trader.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_quote_accounts),
            quote_amount_in,
        )?;

        // 2. Transfer base tokens from base_vault to trader using PDA signers
        let base_mint = market.base_mint;
        let quote_mint = market.quote_mint;
        let bump = market.bump;
        let seeds: &[&[&[u8]]] = &[&[
            b"daejin_market",
            base_mint.as_ref(),
            quote_mint.as_ref(),
            &[bump],
        ]];

        let cpi_base_accounts = Transfer {
            from: ctx.accounts.base_vault.to_account_info(),
            to: ctx.accounts.trader_base_account.to_account_info(),
            authority: market.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_base_accounts,
                seeds,
            ),
            base_out,
        )?;

        emit!(TradeExecutedEvent {
            market: market.key(),
            trader: ctx.accounts.trader.key(),
            is_buy: true,
            amount_in: quote_amount_in,
            amount_out: base_out,
            base_reserve: market.base_reserve,
            quote_reserve: market.quote_reserve,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Swaps Base tokens for Quote tokens.
    pub fn sell(ctx: Context<Trade>, base_amount_in: u64, min_quote_amount_out: u64) -> Result<()> {
        require!(base_amount_in > 0, DaejinError::ZeroAmount);

        let market = &mut ctx.accounts.market;
        let base_in = base_amount_in as u128;
        let base_reserve = market.base_reserve as u128;
        let quote_reserve = market.quote_reserve as u128;

        // dx = base_in, dy = (quote_reserve * dx) / (base_reserve + dx)
        let numerator = quote_reserve
            .checked_mul(base_in)
            .ok_or(DaejinError::MathOverflow)?;
        let denominator = base_reserve
            .checked_add(base_in)
            .ok_or(DaejinError::MathOverflow)?;
        let gross_quote_out = numerator.checked_div(denominator).ok_or(DaejinError::MathOverflow)?;

        let fee_bps = market.fee_basis_points as u128;
        let fee_amount = gross_quote_out
            .checked_mul(fee_bps)
            .ok_or(DaejinError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(DaejinError::MathOverflow)?;
        
        let net_quote_out = (gross_quote_out.checked_sub(fee_amount).ok_or(DaejinError::MathOverflow)?) as u64;

        require!(net_quote_out >= min_quote_amount_out, DaejinError::SlippageExceeded);
        require!(net_quote_out < market.quote_reserve, DaejinError::InsufficientReserve);

        market.base_reserve = market
            .base_reserve
            .checked_add(base_amount_in)
            .ok_or(DaejinError::MathOverflow)?;
        market.quote_reserve = market
            .quote_reserve
            .checked_sub(net_quote_out)
            .ok_or(DaejinError::MathOverflow)?;
        market.total_volume = market
            .total_volume
            .checked_add(net_quote_out)
            .ok_or(DaejinError::MathOverflow)?;
        market.trade_count = market.trade_count.checked_add(1).ok_or(DaejinError::MathOverflow)?;

        // 1. Transfer base tokens from trader to base_vault
        let cpi_base_accounts = Transfer {
            from: ctx.accounts.trader_base_account.to_account_info(),
            to: ctx.accounts.base_vault.to_account_info(),
            authority: ctx.accounts.trader.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_base_accounts),
            base_amount_in,
        )?;

        // 2. Transfer quote tokens from quote_vault to trader using PDA signers
        let base_mint = market.base_mint;
        let quote_mint = market.quote_mint;
        let bump = market.bump;
        let seeds: &[&[&[u8]]] = &[&[
            b"daejin_market",
            base_mint.as_ref(),
            quote_mint.as_ref(),
            &[bump],
        ]];

        let cpi_quote_accounts = Transfer {
            from: ctx.accounts.quote_vault.to_account_info(),
            to: ctx.accounts.trader_quote_account.to_account_info(),
            authority: market.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_quote_accounts,
                seeds,
            ),
            net_quote_out,
        )?;

        emit!(TradeExecutedEvent {
            market: market.key(),
            trader: ctx.accounts.trader.key(),
            is_buy: false,
            amount_in: base_amount_in,
            amount_out: net_quote_out,
            base_reserve: market.base_reserve,
            quote_reserve: market.quote_reserve,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + MarketState::INIT_SPACE,
        seeds = [b"daejin_market", base_mint.key().as_ref(), quote_mint.key().as_ref()],
        bump
    )]
    pub market: Account<'info, MarketState>,

    pub base_mint: Account<'info, Mint>,
    pub quote_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        token::mint = base_mint,
        token::authority = market,
        seeds = [b"base_vault", market.key().as_ref()],
        bump
    )]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        token::mint = quote_mint,
        token::authority = market,
        seeds = [b"quote_vault", market.key().as_ref()],
        bump
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = creator_base_account.mint == base_mint.key() @ DaejinError::InvalidMint,
        constraint = creator_base_account.owner == creator.key() @ DaejinError::InvalidOwner
    )]
    pub creator_base_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(
        mut,
        seeds = [b"daejin_market", market.base_mint.as_ref(), market.quote_mint.as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        address = market.base_vault @ DaejinError::InvalidVault
    )]
    pub base_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        address = market.quote_vault @ DaejinError::InvalidVault
    )]
    pub quote_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = trader_base_account.mint == market.base_mint @ DaejinError::InvalidMint,
        constraint = trader_base_account.owner == trader.key() @ DaejinError::InvalidOwner
    )]
    pub trader_base_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = trader_quote_account.mint == market.quote_mint @ DaejinError::InvalidMint,
        constraint = trader_quote_account.owner == trader.key() @ DaejinError::InvalidOwner
    )]
    pub trader_quote_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub trader: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct MarketState {
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    pub total_volume: u64,
    pub trade_count: u64,
    pub fee_basis_points: u16,
    pub bump: u8,
}

#[event]
pub struct MarketInitializedEvent {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    pub timestamp: i64,
}

#[event]
pub struct TradeExecutedEvent {
    pub market: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum DaejinError {
    #[msg("Fee basis points cannot exceed 1000 (10%)")]
    FeeTooHigh,
    #[msg("Initial reserve cannot be zero")]
    ZeroReserve,
    #[msg("Trade amount cannot be zero")]
    ZeroAmount,
    #[msg("Slippage limit exceeded")]
    SlippageExceeded,
    #[msg("Insufficient reserve liquidity for requested swap")]
    InsufficientReserve,
    #[msg("Numerical overflow in bonding curve calculation")]
    MathOverflow,
    #[msg("Invalid token mint account supplied")]
    InvalidMint,
    #[msg("Invalid token account owner")]
    InvalidOwner,
    #[msg("Invalid token vault PDA supplied")]
    InvalidVault,
}