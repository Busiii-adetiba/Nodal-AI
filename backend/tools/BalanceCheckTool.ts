import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { loadAccount } from '../rpc_client';
import { findBalance } from './balanceHelpers';

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

    const balance = findBalance(account, input.assetCode, input.assetIssuer);
    return balance?.balance ?? '0';
  }
}
