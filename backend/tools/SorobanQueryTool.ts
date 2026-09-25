/**
 * backend/tools/SorobanQueryTool.ts
 * Read-only Soroban contract query tool.
 *
 * Always runs simulation via prepareSorobanTx and never broadcasts.
 * This is the safe default for AI-agent read operations.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Contract,
  BASE_FEE,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { loadAccount, prepareSorobanTx, resolveNetworkPassphrase } from '../rpc_client';
import { createLogger } from '../utils/logger';
import { SorobanInvokeInputSchema, SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

const log = createLogger('soroban-query');

/**
 * Reuses the Soroban invoke input schema but omits `simulateOnly` because this
 * tool is always read-only.
 */
export const SorobanQueryInputSchema = SorobanInvokeInputSchema.omit({ simulateOnly: true });

export type SorobanQueryInput = z.infer<typeof SorobanQueryInputSchema>;

export interface SorobanQueryResult {
  simulationResult: unknown;
}

export class SorobanQueryTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /**
   * Simulate a Soroban contract call without broadcasting a transaction.
   */
  async query(rawInput: unknown): Promise<SorobanQueryResult> {
    const input = SorobanQueryInputSchema.parse(rawInput);

    // Validate contractId format - reject invalid IDs early with a clear error
    const contract = new Contract(input.contractId);

    const sourceAccount = await loadAccount(this.keypair.publicKey());

    log.info(
      { method: input.method, contractId: input.contractId },
      'Building Soroban query transaction'
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(input.method, ...input.args))
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    const simulationResult = await prepareSorobanTx(tx);

    log.info(
      { method: input.method, contractId: input.contractId },
      'Soroban query simulation complete'
    );

    return { simulationResult };
  }
}
