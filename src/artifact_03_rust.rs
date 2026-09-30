use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, MintTo, Burn};

declare_id!("Daej1nMarketEng1ne111111111111111111111111111");

#[program]
pub mod daejin_engine {
    use super::*;

    /// Initialize a new trading market on Daejin with base/quote vaults and LP token mint.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= 1000, DaejinError::FeeTooHigh); // Max 10% fee

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.market_id = market_id;
        market.mint_a = ctx.accounts.mint_a.key();
        market.mint_b = ctx.accounts.mint_b.key();
        market.vault_a = ctx.accounts.vault_a.key();
        market.vault_b = ctx.accounts.vault_b.key();
        market.lp_mint = ctx.accounts.lp_mint.key();
        market.fee_bps = fee_bps;
        market.is_settled = false;
        market.winning_side = 0;
        market.bump = ctx.bumps.market;
        market.vault_a_bump = ctx.bumps.vault_a;
        market.vault_b_bump = ctx.bumps.vault_b;
        market.lp_bump = ctx.bumps.lp_mint;

        emit!(MarketInitialized {
            market_id,
            market: market.key(),
            authority: market.authority,
            mint_a: market.mint_a,
            mint_b: market.mint_b,
            fee_bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposit seed liquidity into the Daejin market to bootstrap trading.
    pub fn deposit_liquidity(
        ctx: Context<DepositLiquidity>,
        amount_a: u64,
        amount_b: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        require!(amount_a > 0 && amount_b > 0, DaejinError::ZeroDepositAmount);

        let market = &ctx.accounts.market;
        let total_lp_supply = ctx.accounts.lp_mint.supply;

        let lp_to_mint: u64 = if total_lp_supply == 0 {
            // Initial LP tokens = sqrt(amount_a * amount_b)
            let product = (amount_a as u128)
                .checked_mul(amount_b as u128)
                .ok_or(DaejinError::MathOverflow)?;
            integer_sqrt(product) as u64
        } else {
            let reserve_a = ctx.accounts.vault_a.amount;
            let reserve_b = ctx.accounts.vault_b.amount;

            let lp_from_a = (amount_a as u128)
                .checked_mul(total_lp_supply as u128)
                .ok_or(DaejinError::MathOverflow)?
                .checked_div(reserve_a as u128)
                .ok_or(DaejinError::MathOverflow)?;

            let lp_from_b = (amount_b as u128)
                .checked_mul(total_lp_supply as u128)
                .ok_or(DaejinError::MathOverflow)?
                .checked_div(reserve_b as u128)
                .ok_or(DaejinError::MathOverflow)?;

            std::cmp::min(lp_from_a, lp_from_b) as u64
        };

        require!(lp_to_mint >= min_lp_out, DaejinError::ExcessiveSlippage);

        // Transfer token A from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_a.to_account_info(),
                    to: ctx.accounts.vault_a.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_a,
        )?;

        // Transfer token B from user to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_b.to_account_info(),
                    to: ctx.accounts.vault_b.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount_b,
        )?;

        // Mint LP tokens via Market PDA signing
        let market_id_bytes = market.market_id.to_le_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            b"market",
            market_id_bytes.as_ref(),
            &[market.bump],
        ]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp.to_account_info(),
                    authority: ctx.accounts.market.to_account_info(),
                },
                seeds,
            ),
            lp_to_mint,
        )?;

        emit!(LiquidityDeposited {
            market_id: market.market_id,
            user: ctx.accounts.user.key(),
            amount_a,
            amount_b,
            lp_minted: lp_to_mint,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Swap base for quote or quote for base using Constant Product Market Making (CPMM).
    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_amount_out: u64,
        swap_a_to_b: bool,
    ) -> Result<()> {
        require!(amount_in > 0, DaejinError::ZeroSwapAmount);
        let market = &ctx.accounts.market;
        require!(!market.is_settled, DaejinError::MarketAlreadySettled);

        let reserve_in = if swap_a_to_b {
            ctx.accounts.vault_a.amount
        } else {
            ctx.accounts.vault_b.amount
        };

        let reserve_out = if swap_a_to_b {
            ctx.accounts.vault_b.amount
        } else {
            ctx.accounts.vault_a.amount
        };

        require!(reserve_in > 0 && reserve_out > 0, DaejinError::InsufficientPoolLiquidity);

        // Deduct protocol fee
        let fee_amount = (amount_in as u128)
            .checked_mul(market.fee_bps as u128)
            .ok_or(DaejinError::MathOverflow)?
            .checked_div(10000)
            .ok_or(DaejinError::MathOverflow)? as u64;

        let effective_amount_in = amount_in
            .checked_sub(fee_amount)
            .ok_or(DaejinError::MathOverflow)?;

        // Constant product: dy = (reserve_out * dx) / (reserve_in + dx)
        let numerator = (effective_amount_in as u128)
            .checked_mul(reserve_out as u128)
            .ok_or(DaejinError::MathOverflow)?;
        let denominator = (reserve_in as u128)
            .checked_add(effective_amount_in as u128)
            .ok_or(DaejinError::MathOverflow)?;
        let amount_out = (numerator.checked_div(denominator).ok_or(DaejinError::MathOverflow)?) as u64;

        require!(amount_out >= min_amount_out, DaejinError::ExcessiveSlippage);

        let market_id_bytes = market.market_id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"market",
            market_id_bytes.as_ref(),
            &[market.bump],
        ]];

        if swap_a_to_b {
            // User deposits Token A
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_a.to_account_info(),
                        to: ctx.accounts.vault_a.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;

            // Market disburses Token B
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_b.to_account_info(),
                        to: ctx.accounts.user_token_b.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_out,
            )?;
        } else {
            // User deposits Token B
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.user_token_b.to_account_info(),
                        to: ctx.accounts.vault_b.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;

            // Market disburses Token A
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_a.to_account_info(),
                        to: ctx.accounts.user_token_a.to_account_info(),
                        authority: ctx.accounts.market.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_out,
            )?;
        }

        emit!(SwapExecuted {
            market_id: market.market_id,
            user: ctx.accounts.user.key(),
            swap_a_to_b,
            amount_in,
            amount_out,
            fee_amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Settle market outcome (1 = Token A wins, 2 = Token B wins)
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        winning_side: u8,
    ) -> Result<()> {
        require!(winning_side == 1 || winning_side == 2, DaejinError::InvalidWinningSide);
        let market = &mut ctx.accounts.market;
        require!(!market.is_settled, DaejinError::MarketAlreadySettled);

        market.is_settled = true;
        market.winning_side = winning_side;

        emit!(MarketSettled {
            market_id: market.market_id,
            winning_side,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// Pure Math Helper
// -----------------------------------------------------------------------------
fn integer_sqrt(y: u128) -> u128 {
    if y == 0 {
        return 0;
    }
    let mut z = y;
    let mut x = y / 2 + 1;
    while x < z {
        z = x;
        x = (y / x + x) / 2;
    }
    z
}

// -----------------------------------------------------------------------------
// Account Contexts
// -----------------------------------------------------------------------------
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + MarketState::INIT_SPACE,
        seeds = [b"market", market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, MarketState>,

    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault_a", market.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = market
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault_b", market.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = market
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = authority,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump,
        mint::decimals = 6,
        mint::authority = market
    )]
    pub lp_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"vault_a", market.key().as_ref()],
        bump = market.vault_a_bump
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_b", market.key().as_ref()],
        bump = market.vault_b_bump
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"lp_mint", market.key().as_ref()],
        bump = market.lp_bump
    )]
    pub lp_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_a.mint == market.mint_a,
        constraint = user_token_a.owner == user.key()
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == market.mint_b,
        constraint = user_token_b.owner == user.key()
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_lp.mint == lp_mint.key(),
        constraint = user_lp.owner == user.key()
    )]
    pub user_lp: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [b"vault_a", market.key().as_ref()],
        bump = market.vault_a_bump
    )]
    pub vault_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault_b", market.key().as_ref()],
        bump = market.vault_b_bump
    )]
    pub vault_b: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_a.mint == market.mint_a,
        constraint = user_token_a.owner == user.key()
    )]
    pub user_token_a: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_token_b.mint == market.mint_b,
        constraint = user_token_b.owner == user.key()
    )]
    pub user_token_b: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(
        mut,
        has_one = authority @ DaejinError::Unauthorized,
        seeds = [b"market", market.market_id.to_le_bytes().as_ref()],
        bump = market.bump
    )]
    pub market: Account<'info, MarketState>,
    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// State Definition
// -----------------------------------------------------------------------------
#[account]
#[derive(InitSpace)]
pub struct MarketState {
    pub authority: Pubkey,
    pub market_id: u64,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub vault_a: Pubkey,
    pub vault_b: Pubkey,
    pub lp_mint: Pubkey,
    pub fee_bps: u16,
    pub is_settled: bool,
    pub winning_side: u8,
    pub bump: u8,
    pub vault_a_bump: u8,
    pub vault_b_bump: u8,
    pub lp_bump: u8,
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------
#[event]
pub struct MarketInitialized {
    pub market_id: u64,
    pub market: Pubkey,
    pub authority: Pubkey,
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub fee_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct LiquidityDeposited {
    pub market_id: u64,
    pub user: Pubkey,
    pub amount_a: u64,
    pub amount_b: u64,
    pub lp_minted: u64,
    pub timestamp: i64,
}

#[event]
pub struct SwapExecuted {
    pub market_id: u64,
    pub user: Pubkey,
    pub swap_a_to_b: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct MarketSettled {
    pub market_id: u64,
    pub winning_side: u8,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------
#[error_code]
pub enum DaejinError {
    #[msg("Fee cannot exceed 1000 basis points (10%).")]
    FeeTooHigh,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDepositAmount,
    #[msg("Mathematical calculation produced an overflow.")]
    MathOverflow,
    #[msg("Swap amount exceeds permitted slippage bounds.")]
    ExcessiveSlippage,
    #[msg("Swap input amount must be greater than zero.")]
    ZeroSwapAmount,
    #[msg("Market is already settled.")]
    MarketAlreadySettled,
    #[msg("Insufficient pool liquidity to complete swap.")]
    InsufficientPoolLiquidity,
    #[msg("Invalid winning side indicator (must be 1 or 2).")]
    InvalidWinningSide,
    #[msg("Signer is not authorized to settle this market.")]
    Unauthorized,
}