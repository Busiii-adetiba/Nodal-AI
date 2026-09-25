import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { loadAccount } from '../rpc_client';

const stellarPublicKeySchema = z
  .string()
  .trim()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), {
    message: 'Invalid Stellar public key',
  });

export const BalanceCheckInputSchema = z.object({
  publicKey: stellarPublicKeySchema,
  /** Asset issuer (required for non-native assets, optional for XLM/native) */
  assetIssuer: z
    .string()
    .trim()
    .refine(
      (value) => !value || StrKey.isValidEd25519PublicKey(value),
      { message: 'Invalid Stellar asset issuer' }
    )
    .optional(),
  /** Asset code (omit or use 'XLM' for native lumen balance) */
  assetCode: z.string().trim().min(1).optional(),
});

export type BalanceCheckInput = z.infer<typeof BalanceCheckInputSchema>;

export class BalanceCheckTool {
  /**
   * Execute a balance check for a given public key and optional asset.
   *
   * Contract:
   * - If assetCode is omitted or 'XLM', returns the native XLM balance
   * - If assetCode is provided with assetIssuer, returns that asset's balance
   * - assetIssuer is required for non-native assets, optional for native XLM
   *
   * @param rawInput - Must contain publicKey. Optionally assetCode and assetIssuer
   * @returns Balance as a string, or '0' if not found
   */
  async execute(rawInput: unknown): Promise<string> {
    const input = BalanceCheckInputSchema.parse(rawInput);
    const account = await loadAccount(input.publicKey);
    const balances = account.balances as any[];

    // Native XLM balance lookup: when assetCode is omitted, undefined, or 'XLM'
    if (!input.assetCode || input.assetCode === 'XLM') {
      const nativeBalance = balances.find((entry) => entry.asset_type === 'native');
      return nativeBalance?.balance ?? '0';
    }

    // Non-native asset balance lookup
    const balance = balances.find(
      (entry) =>
        entry.asset_type !== 'native' &&
        entry.asset_code === input.assetCode &&
        entry.asset_issuer === input.assetIssuer
    );

    return balance?.balance ?? '0';
  }
}
