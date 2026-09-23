/**
 * backend/tools/BatchPaymentTool.ts
 *
 * Executes 1–100 payment operations in a single atomic Stellar transaction.
 * Spending limit is enforced on the aggregate amount (sum of all payments).
 *
 * Because the batch is one transaction, it either applies in full or not at
 * all — there is no partial application to unwind. `failFast` therefore governs
 * the pre-flight check that runs before anything is submitted: with it set, the
 * first unusable payment aborts the batch and the payments behind it are
 * reported as skipped; without it every payment is checked so the caller gets
 * the full list of problems in one round trip.
 */

import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { ValidationError } from '../errors';
import { loadAccount, resolveNetworkPassphrase, submitTransaction } from '../rpc_client';
import { PaymentInputSchema, SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

export const BatchPaymentInputSchema = z.object({
  payments: z.array(PaymentInputSchema).min(1).max(100),
  /**
   * Abort the batch at the first unusable payment instead of reporting every
   * problem at once. Defaults to false so existing callers are unaffected.
   */
  failFast: z.boolean().optional().default(false),
});

export type BatchPaymentInput = z.infer<typeof BatchPaymentInputSchema>;

// Stellar's smallest unit is the stroop (1 XLM = 10,000,000 stroops), matching
// the network's 7-decimal-place amount precision. Summing in stroops (BigInt)
// instead of parseFloat avoids floating-point rounding error accumulating
// across up to 100 payment amounts.
const STROOP_SCALE = 10_000_000n;

function toStroops(decimal: string): bigint {
  const [whole, fraction = ''] = decimal.split('.');
  return BigInt(whole) * STROOP_SCALE + BigInt(fraction.padEnd(7, '0'));
}

function fromStroops(stroops: bigint): string {
  const whole = stroops / STROOP_SCALE;
  const fraction = stroops % STROOP_SCALE;
  return `${whole}.${fraction.toString().padStart(7, '0')}`;
}

export interface BatchPaymentResult {
  txHash: string;
  ledger: number;
  /**
   * Payments that were never attempted. Only non-zero when a failed pre-flight
   * ended the batch early under `failFast`; a submitted batch is atomic, so on
   * success nothing is skipped.
   */
  skipped: number;
}

/** Raised when a batch is rejected before submission, carrying the skip count. */
export class BatchPreflightError extends ValidationError {
  readonly skipped: number;

  constructor(message: string, skipped: number, cause?: unknown) {
    super(message, cause);
    this.skipped = skipped;
    Object.setPrototypeOf(this, BatchPreflightError.prototype);
  }
}

export class BatchPaymentTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(rawInput: unknown): Promise<BatchPaymentResult> {
    const { payments, failFast } = BatchPaymentInputSchema.parse(rawInput);

    // Aggregate spending limit check
    const totalStroops = payments.reduce((sum, p) => sum + toStroops(p.amount), 0n);
    const limitStroops = toStroops(config.AGENT_SPENDING_LIMIT);
    if (totalStroops > limitStroops) {
      throw new Error(
        `Batch total ${fromStroops(totalStroops)} ${config.X402_ASSET_CODE} exceeds AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
      );
    }

    // Pre-flight every payment before touching the network. Nothing here can be
    // partially applied, so a problem found now costs the caller nothing.
    const problems: string[] = [];
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i]!;
      if (p.assetCode !== 'XLM' && !p.assetIssuer) {
        problems.push(`payment ${i}: Asset issuer is required for non-native asset ${p.assetCode}`);
        if (failFast) {
          // Everything behind the failure is left untouched.
          throw new BatchPreflightError(problems[0]!, payments.length - i - 1);
        }
      }
    }

    if (problems.length > 0) {
      throw new BatchPreflightError(problems.join('; '), 0);
    }

    const sourceAccount = await loadAccount(this.keypair.publicKey());

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    for (const p of payments) {
      const asset = p.assetCode === 'XLM' ? Asset.native() : new Asset(p.assetCode, p.assetIssuer);
      builder.addOperation(
        Operation.payment({ destination: p.destination, asset, amount: p.amount })
      );
    }

    const tx = builder.setTimeout(SOROBAN_TX_TIMEOUT).build();
    tx.sign(this.keypair);

    const result = SubmitResultSchema.parse(await submitTransaction(tx));
    // The batch is atomic: a submitted transaction applies every payment.
    return { txHash: result.hash, ledger: result.ledger, skipped: 0 };
  }
}
