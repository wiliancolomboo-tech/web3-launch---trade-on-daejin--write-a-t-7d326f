use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Daej1n1111111111111111111111111111111111111");

#[program]
pub mod daejin_engine {
    use super::*;

    /// Initializes a new prediction / conditional market.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: String,
        question: String,
        fee_bps: u16,
        resolution_timestamp: i64,
    ) -> Result<()> {
        require!(market_id.len() <= 32, DaejinError::StringTooLong);
        require!(question.len() <= 200, DaejinError::StringTooLong);
        require!(fee_bps <= 1000, DaejinError::FeeTooHigh); // Max 10%

        let clock = Clock::get()?;
        require!(
            resolution_timestamp > clock.unix_timestamp,
            DaejinError::InvalidResolutionTimestamp
        );

        let market = &mut ctx.accounts.market;
        market.authority = ctx.accounts.authority.key();
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.vault = ctx.accounts.vault.key();
        market.market_id = market_id;
        market.question = question;
        market.fee_bps = fee_bps;
        market.resolution_timestamp = resolution_timestamp;
        market.is_resolved = false;
        market.winning_outcome = None;
        market.total_yes_shares = 0;
        market.total_no_shares = 0;
        market.vault_bump = ctx.bumps.vault;
        market.market_bump = ctx.bumps.market;

        emit!(MarketCreatedEvent {
            market: market.key(),
            authority: market.authority,
            market_id: market.market_id.clone(),
            resolution_timestamp,
        });

        Ok(())
    }

    /// Buys outcome shares (YES or NO) by depositing collateral into the pool.
    pub fn buy_shares(
        ctx: Context<BuyShares>,
        outcome: Outcome,
        collateral_amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        require!(collateral_amount > 0, DaejinError::ZeroAmount);
        let clock = Clock::get()?;
        let market = &mut ctx.accounts.market;

        require!(!market.is_resolved, DaejinError::MarketAlreadyResolved);
        require!(
            clock.unix_timestamp < market.resolution_timestamp,
            DaejinError::MarketExpired
        );

        // Calculate fee
        let fee = (collateral_amount as u128 * market.fee_bps as u128 / 10_000) as u64;
        let net_collateral = collateral_amount
            .checked_sub(fee)
            .ok_or(DaejinError::MathOverflow)?;

        // Transfer collateral from user to market vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_collateral.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, collateral_amount)?;

        // Calculate shares to issue based on a fair parimutuel / constant-sum pricing rule
        // net_collateral purchases 1:1 shares in this outcome pool
        let shares_to_issue = net_collateral;
        require!(
            shares_to_issue >= min_shares_out,
            DaejinError::SlippageExceeded
        );

        let user_position = &mut ctx.accounts.user_position;
        if user_position.market == Pubkey::default() {
            user_position.market = market.key();
            user_position.user = ctx.accounts.user.key();
            user_position.bump = ctx.bumps.user_position;
        }

        match outcome {
            Outcome::Yes => {
                market.total_yes_shares = market
                    .total_yes_shares
                    .checked_add(shares_to_issue)
                    .ok_or(DaejinError::MathOverflow)?;
                user_position.yes_shares = user_position
                    .yes_shares
                    .checked_add(shares_to_issue)
                    .ok_or(DaejinError::MathOverflow)?;
            }
            Outcome::No => {
                market.total_no_shares = market
                    .total_no_shares
                    .checked_add(shares_to_issue)
                    .ok_or(DaejinError::MathOverflow)?;
                user_position.no_shares = user_position
                    .no_shares
                    .checked_add(shares_to_issue)
                    .ok_or(DaejinError::MathOverflow)?;
            }
        }

        emit!(SharesPurchasedEvent {
            market: market.key(),
            user: ctx.accounts.user.key(),
            outcome,
            collateral_spent: collateral_amount,
            shares_minted: shares_to_issue,
        });

        Ok(())
    }

    /// Resolves the market with the definitive winning outcome.
    pub fn resolve_market(ctx: Context<ResolveMarket>, winning_outcome: Outcome) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.is_resolved, DaejinError::MarketAlreadyResolved);
        require!(
            ctx.accounts.authority.key() == market.authority,
            DaejinError::Unauthorized
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= market.resolution_timestamp,
            DaejinError::MarketNotYetResolvable
        );

        market.is_resolved = true;
        market.winning_outcome = Some(winning_outcome);

        emit!(MarketResolvedEvent {
            market: market.key(),
            winning_outcome,
            resolved_at: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claims rewards for a winning position after market settlement.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.user_position;

        require!(market.is_resolved, DaejinError::MarketNotResolved);
        let winning_outcome = market
            .winning_outcome
            .ok_or(DaejinError::WinningOutcomeNotSet)?;

        let (winning_shares, total_winning_shares) = match winning_outcome {
            Outcome::Yes => (position.yes_shares, market.total_yes_shares),
            Outcome::No => (position.no_shares, market.total_no_shares),
        };

        require!(winning_shares > 0, DaejinError::NoWinningShares);

        let vault_balance = ctx.accounts.vault.amount;
        // Payout = (winning_shares / total_winning_shares) * total_vault_balance
        let payout = ((winning_shares as u128)
            .checked_mul(vault_balance as u128)
            .ok_or(DaejinError::MathOverflow)?
            .checked_div(total_winning_shares as u128)
            .ok_or(DaejinError::MathOverflow)?) as u64;

        require!(payout > 0, DaejinError::ZeroPayout);

        // Reset shares to prevent reentrancy double-spend
        match winning_outcome {
            Outcome::Yes => position.yes_shares = 0,
            Outcome::No => position.no_shares = 0,
        }

        // PDA signer seeds for vault transfer
        let market_id_bytes = market.market_id.as_bytes();
        let market_seeds = &[
            b"market",
            market_id_bytes,
            &[market.market_bump],
        ];
        let vault_seeds = &[
            b"vault",
            market.to_account_info().key.as_ref(),
            &[market.vault_bump],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.user_collateral.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, payout)?;

        emit!(WinningsClaimedEvent {
            market: market.key(),
            user: ctx.accounts.user.key(),
            payout,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT DATA STRUCTURES
// -----------------------------------------------------------------------------

#[account]
pub struct Market {
    pub authority: Pubkey,          // 32
    pub collateral_mint: Pubkey,    // 32
    pub vault: Pubkey,              // 32
    pub market_id: String,          // 4 + 32
    pub question: String,           // 4 + 200
    pub fee_bps: u16,               // 2
    pub resolution_timestamp: i64,  // 8
    pub is_resolved: bool,          // 1
    pub winning_outcome: Option<Outcome>, // 1 + 1
    pub total_yes_shares: u64,      // 8
    pub total_no_shares: u64,       // 8
    pub vault_bump: u8,             // 1
    pub market_bump: u8,            // 1
}

impl Market {
    pub const LEN: usize = 8 + 32 + 32 + 32 + (4 + 32) + (4 + 200) + 2 + 8 + 1 + 2 + 8 + 8 + 1 + 1;
}

#[account]
pub struct UserPosition {
    pub market: Pubkey, // 32
    pub user: Pubkey,   // 32
    pub yes_shares: u64,// 8
    pub no_shares: u64, // 8
    pub bump: u8,       // 1
}

impl UserPosition {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Yes,
    No,
}

// -----------------------------------------------------------------------------
// INSTRUCTION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(market_id: String)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = Market::LEN,
        seeds = [b"market", market_id.as_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,

    pub collateral_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_bytes()],
        bump = market.market_bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = UserPosition::LEN,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(mut)]
    pub user_collateral: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_bytes()],
        bump = market.market_bump,
        has_one = authority
    )]
    pub market: Account<'info, Market>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(
        mut,
        seeds = [b"market", market.market_id.as_bytes()],
        bump = market.market_bump
    )]
    pub market: Account<'info, Market>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump,
        has_one = user,
        has_one = market
    )]
    pub user_position: Account<'info, UserPosition>,

    #[account(mut)]
    pub user_collateral: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MarketCreatedEvent {
    pub market: Pubkey,
    pub authority: Pubkey,
    pub market_id: String,
    pub resolution_timestamp: i64,
}

#[event]
pub struct SharesPurchasedEvent {
    pub market: Pubkey,
    pub user: Pubkey,
    pub outcome: Outcome,
    pub collateral_spent: u64,
    pub shares_minted: u64,
}

#[event]
pub struct MarketResolvedEvent {
    pub market: Pubkey,
    pub winning_outcome: Outcome,
    pub resolved_at: i64,
}

#[event]
pub struct WinningsClaimedEvent {
    pub market: Pubkey,
    pub user: Pubkey,
    pub payout: u64,
}

#[error_code]
pub enum DaejinError {
    #[msg("String exceeds maximum allowable length.")]
    StringTooLong,
    #[msg("Protocol fee exceeds maximum allowable threshold.")]
    FeeTooHigh,
    #[msg("Resolution timestamp must be strictly in the future.")]
    InvalidResolutionTimestamp,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Market is already resolved.")]
    MarketAlreadyResolved,
    #[msg("Market trading window has expired.")]
    MarketExpired,
    #[msg("Math arithmetic overflow occurred.")]
    MathOverflow,
    #[msg("Execution slippage exceeded tolerance.")]
    SlippageExceeded,
    #[msg("Action unauthorized.")]
    Unauthorized,
    #[msg("Market cannot be resolved before resolution timestamp.")]
    MarketNotYetResolvable,
    #[msg("Market is not resolved yet.")]
    MarketNotResolved,
    #[msg("Winning outcome was not declared.")]
    WinningOutcomeNotSet,
    #[msg("User holds zero winning shares in this market.")]
    NoWinningShares,
    #[msg("Calculated payout resulted in zero.")]
    ZeroPayout,
}