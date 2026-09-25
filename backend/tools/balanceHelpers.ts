/**
 * backend/tools/balanceHelpers.ts
 * Shared typed helpers for Horizon account balances.
 */

import type { Horizon } from '@stellar/stellar-sdk';

/**
 * Properly typed balance entry from Horizon account.
 */
export interface TypedBalance {
  assetType: 'native' | 'credit4' | 'credit12';
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
  limit?: string;
  isAuthorized?: boolean;
  isAuthorizedToMaintainLiabilities?: boolean;
}

/**
 * Convert Horizon's loosely-typed balances to properly typed entries.
 */
export function getTypedBalances(account: Horizon.Account): TypedBalance[] {
  const rawBalances = account.balances as Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    limit?: string;
    is_authorized?: boolean;
    is_authorized_to_maintain_liabilities?: boolean;
  }>;

  return rawBalances.map((b) => ({
    assetType: b.asset_type as TypedBalance['assetType'],
    assetCode: b.asset_code,
    assetIssuer: b.asset_issuer,
    balance: b.balance,
    limit: b.limit,
    isAuthorized: b.is_authorized,
    isAuthorizedToMaintainLiabilities: b.is_authorized_to_maintain_liabilities,
  }));
}

/**
 * Find a balance entry by asset code and issuer.
 */
export function findBalance(
  account: Horizon.Account,
  assetCode: string,
  assetIssuer?: string
): TypedBalance | undefined {
  const balances = getTypedBalances(account);
  return balances.find((b) => {
    if (assetCode === 'XLM' || assetCode === 'native') {
      return b.assetType === 'native';
    }
    return b.assetCode === assetCode && b.assetIssuer === assetIssuer;
  });
}