use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Daej1nMarket11111111111111111111111111111111");

pub const CONFIG_SEED: &[u8] = b"daejin_config";
pub const MARKET_SEED: &[u8] = b"daejin_market";
pub const VAULT_SEED: &[u8] = b"daejin_vault";
pub const YES_MINT_SEED: &[u8] = b"daejin_yes_mint";
pub const NO_MINT_SEED: &[u8] = b"daejin_no_mint";

#[program]
pub mod daejin_market {
    use super::*;

    /// Initializes global protocol state, fee configuration, and treasury address.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_basis_points: u16,
    ) -> Result<()> {
        require!(fee_basis_points <= 1000, DaejinError::FeeExceedsMaximum); // Max 10%

        let config = &mut ctx.accounts.protocol_config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.fee_basis_points = fee_basis_points;
        config.total_markets_created = 0;
        config.bump = ctx.bumps.protocol_config;

        msg!("Daejin Protocol Initialized. Admin: {}", config.admin);
        Ok(())
    }

    /// Initializes a new outcome market, PDA vaults, and YES/NO SPL token mints.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_id: u64,
        resolution_timestamp: i64,
        question: String,
        metadata_uri: String,
    ) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            resolution_timestamp > clock.unix_timestamp,
            DaejinError::InvalidResolutionTimestamp
        );
        require!(question.len() <= 280, DaejinError::QuestionTooLong);
        require!(metadata_uri.len() <= 200, DaejinError::UriTooLong);

        let market = &mut ctx.accounts.market;
        market.market_id = market_id;
        market.creator = ctx.accounts.creator.key();
        market.oracle = ctx.accounts.oracle.key();
        market.collateral_mint = ctx.accounts.collateral_mint.key();
        market.collateral_vault = ctx.accounts.collateral_vault.key();
        market.yes_mint = ctx.accounts.yes_mint.key();
        market.no_mint = ctx.accounts.no_mint.key();
        market.resolution_timestamp = resolution_timestamp;
        market.is_resolved = false;
        market.winning_outcome = Outcome::Unresolved;
        market.total_collateral_deposited = 0;
        market.yes_token_supply = 0;
        market.no_token_supply = 0;
        market.question = question.clone();
        market.metadata_uri = metadata_uri;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.collateral_vault;
        market.yes_mint_bump = ctx.bumps.yes_mint;
        market.no_mint_bump = ctx.bumps.no_mint;

        let config = &mut ctx.accounts.protocol_config;
        config.total_markets_created = config
            .total_markets_created
            .checked_add(1)
            .ok_or(DaejinError::MathOverflow)?;

        emit!(MarketCreatedEvent {
            market_id,
            market_address: market.key(),
            creator: ctx.accounts.creator.key(),
            oracle: ctx.accounts.oracle.key(),
            resolution_timestamp,
            question,
        });

        Ok(())
    }

    /// Deposits collateral and mints equal paired amounts of YES and NO outcome tokens.
    pub fn mint_outcome_pairs(ctx: Context<MintOutcomePairs>, amount: u64) -> Result<()> {
        require!(amount > 0, DaejinError::ZeroDepositAmount);
        let market = &mut ctx.accounts.market;
        require!(!market.is_resolved, DaejinError::MarketAlreadyResolved);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < market.resolution_timestamp,
            DaejinError::MarketExpired
        );

        // 1. Transfer collateral from depositor to the market collateral vault
        let transfer_accounts = Transfer {
            from: ctx.accounts.user_collateral_account.to_account_info(),
            to: ctx.accounts.collateral_vault.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
        );
        token::transfer(cpi_ctx, amount)?;

        // 2. Mint YES outcome tokens
        let market_id_bytes = market.market_id.to_le_bytes();
        let seeds = &[
            MARKET_SEED,
            market_id_bytes.as_ref(),
            &[market.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let mint_yes_accounts = MintTo {
            mint: ctx.accounts.yes_mint.to_account_info(),
            to: ctx.accounts.user_yes_account.to_account_info(),
            authority: market.to_account_info(),
        };
        let mint_yes_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_yes_accounts,
            signer_seeds,
        );
        token::mint_to(mint_yes_ctx, amount)?;

        // 3. Mint NO outcome tokens
        let mint_no_accounts = MintTo {
            mint: ctx.accounts.no_mint.to_account_info(),
            to: ctx.accounts.user_no_account.to_account_info(),
            authority: market.to_account_info(),
        };
        let mint_no_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            mint_no_accounts,
            signer_seeds,
        );
        token::mint_to(mint_no_ctx, amount)?;

        // 4. Update Market State
        market.total_collateral_deposited = market
            .total_collateral_deposited
            .checked_add(amount)
            .ok_or(DaejinError::MathOverflow)?;
        market.yes_token_supply = market
            .yes_token_supply
            .checked_add(amount)
            .ok_or(DaejinError::MathOverflow)?;
        market.no_token_supply = market
            .no_token_supply
            .checked_add(amount)
            .ok_or(DaejinError::MathOverflow)?;

        emit!(PairsMintedEvent {
            market_id: market.market_id,
            user: ctx.accounts.user.key(),
            amount,
        });

        Ok(())
    }

    /// Resolves the market with the definitive winning outcome (Yes, No, or Cancelled).
    pub fn resolve_market(ctx: Context<ResolveMarket>, outcome: Outcome) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(!market.is_resolved, DaejinError::MarketAlreadyResolved);
        require!(
            outcome == Outcome::Yes || outcome == Outcome::No || outcome == Outcome::Invalid,
            DaejinError::InvalidOutcome
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= market.resolution_timestamp,
            DaejinError::ResolutionBeforeExpiry
        );

        market.is_resolved = true;
        market.winning_outcome = outcome;

        emit!(MarketResolvedEvent {
            market_id: market.market_id,
            winning_outcome: outcome,
            resolver: ctx.accounts.oracle.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Claims payouts for winning outcome tokens, deducting protocol fees.
    pub fn claim_settlement(ctx: Context<ClaimSettlement>, amount_to_redeem: u64) -> Result<()> {
        require!(amount_to_redeem > 0, DaejinError::ZeroRedeemAmount);
        let market = &mut ctx.accounts.market;
        require!(market.is_resolved, DaejinError::MarketNotResolved);

        let protocol_config = &ctx.accounts.protocol_config;

        let market_id_bytes = market.market_id.to_le_bytes();
        let market_seeds = &[
            MARKET_SEED,
            market_id_bytes.as_ref(),
            &[market.bump],
        ];
        let market_signer_seeds = &[&market_seeds[..]];

        match market.winning_outcome {
            Outcome::Yes => {
                // Burn YES tokens from user
                let burn_accounts = Burn {
                    mint: ctx.accounts.yes_mint.to_account_info(),
                    from: ctx.accounts.user_outcome_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                };
                let burn_ctx = CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    burn_accounts,
                );
                token::burn(burn_ctx, amount_to_redeem)?;
            }
            Outcome::No => {
                // Burn NO tokens from user
                let burn_accounts = Burn {
                    mint: ctx.accounts.no_mint.to_account_info(),
                    from: ctx.accounts.user_outcome_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                };
                let burn_ctx = CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    burn_accounts,
                );
                token::burn(burn_ctx, amount_to_redeem)?;
            }
            Outcome::Invalid => {
                // If invalid/cancelled, redemption requires equivalent burn of both or handled via refund
                return Err(DaejinError::ManualRefundRequired.into());
            }
            Outcome::Unresolved => return Err(DaejinError::MarketNotResolved.into()),
        }

        // Calculate fee and net payout
        let fee = (amount_to_redeem as u128)
            .checked_mul(protocol_config.fee_basis_points as u128)
            .ok_or(DaejinError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(DaejinError::MathOverflow)? as u64;

        let net_payout = amount_to_redeem
            .checked_sub(fee)
            .ok_or(DaejinError::MathOverflow)?;

        // Transfer Protocol Fee to Treasury
        if fee > 0 {
            let fee_transfer_accounts = Transfer {
                from: ctx.accounts.collateral_vault.to_account_info(),
                to: ctx.accounts.treasury_collateral_account.to_account_info(),
                authority: market.to_account_info(),
            };
            let fee_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                fee_transfer_accounts,
                market_signer_seeds,
            );
            token::transfer(fee_transfer_ctx, fee)?;
        }

        // Transfer Net Collateral to User
        let user_transfer_accounts = Transfer {
            from: ctx.accounts.collateral_vault.to_account_info(),
            to: ctx.accounts.user_collateral_account.to_account_info(),
            authority: market.to_account_info(),
        };
        let user_transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            user_transfer_accounts,
            market_signer_seeds,
        );
        token::transfer(user_transfer_ctx, net_payout)?;

        emit!(SettlementClaimedEvent {
            market_id: market.market_id,
            user: ctx.accounts.user.key(),
            gross_amount: amount_to_redeem,
            net_payout,
            fee_deducted: fee,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Treasury recipient wallet address
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + MarketState::LEN,
        seeds = [MARKET_SEED, &market_id.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub collateral_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market
    )]
    pub collateral_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        seeds = [YES_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market
    )]
    pub yes_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        seeds = [NO_MINT_SEED, market.key().as_ref()],
        bump,
        mint::decimals = collateral_mint.decimals,
        mint::authority = market
    )]
    pub no_mint: Account<'info, Mint>,

    /// CHECK: Validated as designated oracle resolver
    pub oracle: AccountInfo<'info>,

    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintOutcomePairs<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = collateral_vault,
        has_one = yes_mint,
        has_one = no_mint
    )]
    pub market: Account<'info, MarketState>,

    #[account(mut)]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub yes_mint: Account<'info, Mint>,
    #[account(mut)]
    pub no_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_collateral_account.owner == user.key(),
        constraint = user_collateral_account.mint == market.collateral_mint
    )]
    pub user_collateral_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_yes_account.owner == user.key(),
        constraint = user_yes_account.mint == yes_mint.key()
    )]
    pub user_yes_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_no_account.owner == user.key(),
        constraint = user_no_account.mint == no_mint.key()
    )]
    pub user_no_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveMarket<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = oracle @ DaejinError::UnauthorizedOracle
    )]
    pub market: Account<'info, MarketState>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimSettlement<'info> {
    #[account(
        mut,
        seeds = [MARKET_SEED, &market.market_id.to_le_bytes()],
        bump = market.bump,
        has_one = collateral_vault,
        has_one = yes_mint,
        has_one = no_mint
    )]
    pub market: Account<'info, MarketState>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub collateral_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub yes_mint: Account<'info, Mint>,
    #[account(mut)]
    pub no_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_collateral_account.owner == user.key(),
        constraint = user_collateral_account.mint == market.collateral_mint
    )]
    pub user_collateral_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_outcome_account.owner == user.key()
    )]
    pub user_outcome_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_collateral_account.owner == protocol_config.treasury,
        constraint = treasury_collateral_account.mint == market.collateral_mint
    )]
    pub treasury_collateral_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// DATA LAYOUTS & ENUMS
// -----------------------------------------------------------------------------

#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee_basis_points: u16,
    pub total_markets_created: u64,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const LEN: usize = 32 + 32 + 2 + 8 + 1;
}

#[account]
pub struct MarketState {
    pub market_id: u64,
    pub creator: Pubkey,
    pub oracle: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub yes_mint: Pubkey,
    pub no_mint: Pubkey,
    pub resolution_timestamp: i64,
    pub is_resolved: bool,
    pub winning_outcome: Outcome,
    pub total_collateral_deposited: u64,
    pub yes_token_supply: u64,
    pub no_token_supply: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub yes_mint_bump: u8,
    pub no_mint_bump: u8,
    pub question: String,
    pub metadata_uri: String,
}

impl MarketState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 8 + 1 + 1 + 8 + 8 + 8 + 4 + (4 + 280) + (4 + 200);
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Unresolved,
    Yes,
    No,
    Invalid,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MarketCreatedEvent {
    pub market_id: u64,
    pub market_address: Pubkey,
    pub creator: Pubkey,
    pub oracle: Pubkey,
    pub resolution_timestamp: i64,
    pub question: String,
}

#[event]
pub struct PairsMintedEvent {
    pub market_id: u64,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct MarketResolvedEvent {
    pub market_id: u64,
    pub winning_outcome: Outcome,
    pub resolver: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct SettlementClaimedEvent {
    pub market_id: u64,
    pub user: Pubkey,
    pub gross_amount: u64,
    pub net_payout: u64,
    pub fee_deducted: u64,
}

#[error_code]
pub enum DaejinError {
    #[msg("Fee basis points cannot exceed 1000 (10%)")]
    FeeExceedsMaximum,
    #[msg("Resolution timestamp must be set in the future")]
    InvalidResolutionTimestamp,
    #[msg("Question cannot exceed 280 characters")]
    QuestionTooLong,
    #[msg("Metadata URI cannot exceed 200 characters")]
    UriTooLong,
    #[msg("Deposit amount must be greater than zero")]
    ZeroDepositAmount,
    #[msg("Market is already resolved")]
    MarketAlreadyResolved,
    #[msg("Market has expired for minting")]
    MarketExpired,
    #[msg("Unauthorized oracle signer")]
    UnauthorizedOracle,
    #[msg("Market cannot be resolved before expiration")]
    ResolutionBeforeExpiry,
    #[msg("Invalid outcome selection")]
    InvalidOutcome,
    #[msg("Market is not yet resolved")]
    MarketNotResolved,
    #[msg("Redemption amount must be greater than zero")]
    ZeroRedeemAmount,
    #[msg("Market resolved as invalid; use cancellation refund procedure")]
    ManualRefundRequired,
    #[msg("Arithmetic overflow detected")]
    MathOverflow,
}