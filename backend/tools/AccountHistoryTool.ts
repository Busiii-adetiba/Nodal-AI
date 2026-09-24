/**
 * backend/tools/AccountHistoryTool.ts
 * Fetch paginated payment operations for an account from Horizon.
 */

import { z } from 'zod';
import { config } from '../config';
import { horizonServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';

export interface PaymentRecord {
  id: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  asset: string;
  createdAt: string;
  pagingToken: string;
}

export interface AccountHistoryResult {
  records: PaymentRecord[];
  nextCursor: string | null;
}

export const AccountHistoryInputSchema = z.object({
  publicKey: z.string().length(56, 'Invalid Stellar public key').optional(),
  limit: z.number().int().min(1).max(200).optional().default(10),
  cursor: z.string().optional(),
  assetCode: z.string().optional(),
});

export type AccountHistoryInput = z.infer<typeof AccountHistoryInputSchema>;

function formatAsset(assetType: string, assetCode?: string, assetIssuer?: string): string {
  if (assetType === 'native') return 'XLM';
  return `${assetCode}:${assetIssuer}`;
}

function matchesAssetCode(asset: string, filterCode: string): boolean {
  if (filterCode === 'XLM') {
    return asset === 'XLM';
  }
  return asset.startsWith(`${filterCode}:`);
}

function toPaymentRecord(record: {
  id: string;
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  created_at: string;
  paging_token: string;
}): PaymentRecord | null {
  if (record.type !== 'payment') {
    return null;
  }

  return {
    id: record.id,
    type: record.type,
    from: record.from ?? '',
    to: record.to ?? '',
    amount: record.amount ?? '0',
    asset: formatAsset(record.asset_type, record.asset_code, record.asset_issuer),
    createdAt: record.created_at,
    pagingToken: record.paging_token,
  };
}

export class AccountHistoryTool {
  async fetch(rawInput: unknown): Promise<AccountHistoryResult> {
    const input = AccountHistoryInputSchema.parse(rawInput);
    const publicKey = input.publicKey ?? config.AGENT_PUBLIC_KEY;

    let query = horizonServer.payments().forAccount(publicKey).order('desc').limit(input.limit);

    if (input.cursor) {
      query = query.cursor(input.cursor);
    }

    const response = await withBackoffGuard(() =>
      withRetry(() => query.call(), config.MAX_RETRIES, config.RETRY_DELAY_MS)
    );

    let records = response.records
      .map((record) =>
        toPaymentRecord(
          record as {
            id: string;
            type: string;
            from?: string;
            to?: string;
            amount?: string;
            asset_type: string;
            asset_code?: string;
            asset_issuer?: string;
            created_at: string;
            paging_token: string;
          }
        )
      )
      .filter((record): record is PaymentRecord => record !== null);

    if (input.assetCode) {
      records = records.filter((record) => matchesAssetCode(record.asset, input.assetCode!));
    }

    const nextCursor =
      response.records.length > 0 && response.records.length === input.limit
        ? (response.records[response.records.length - 1]?.paging_token ?? null)
        : null;

    return { records, nextCursor };
  }
}
