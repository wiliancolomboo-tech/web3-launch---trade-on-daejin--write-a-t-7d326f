use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MarketStatus {
    Active,
    Resolved,
}

#[account]
pub struct Market {
    pub creator: Pubkey,
    pub resolver: Pubkey,
    pub collateral_mint: Pubkey,
    pub outcome_a_mint: Pubkey,
    pub outcome_b_mint: Pubkey,
    pub collateral_vault: Pubkey,
    pub market_id: u64,
    pub fee_bps: u16,
    pub pool_collateral: u64,
    pub pool_outcome_a: u64,
    pub pool_outcome_b: u64,
    pub winning_outcome: u8, // 0 = None, 1 = A, 2 = B
    pub status: MarketStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Market {
    pub const LEN: usize = 8 + // discriminator
        32 + // creator
        32 + // resolver
        32 + // collateral_mint
        32 + // outcome_a_mint
        32 + // outcome_b_mint
        32 + // collateral_vault
        8 +  // market_id
        2 +  // fee_bps
        8 +  // pool_collateral
        8 +  // pool_outcome_a
        8 +  // pool_outcome_b
        1 +  // winning_outcome
        1 +  // status enum
        1 +  // bump
        1 +  // vault_bump
        64;  // padding
}