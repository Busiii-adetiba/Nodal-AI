/**
 * backend/tools/TransactionBuilderTool.ts
 *
 * Composes multi-operation Stellar transactions from an array of AgentTasks.
 * Supports batching arbitrary operations, signing, submitting, or simulating only.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  BASE_FEE,
  Contract,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { logger } from '../logger';
import { loadAccount, resolveNetworkPassphrase, submitTransaction } from '../rpc_client';
import { AgentTask } from '../agent';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';

export const TransactionBuilderInputSchema = z.object({
  operations: z.array(z.any()).min(1, 'At least one operation is required'),
  memo: z
    .union([
      z.string(),
      z.object({
        type: z.enum(['text', 'id', 'hash', 'return']).optional(),
        value: z.union([z.string(), z.number()]),
      }),
      z.instanceof(Memo),
    ])
    .optional(),
  timeBounds: z
    .union([
      z.number(),
      z.object({
        minTime: z.union([z.number(), z.string()]).optional(),
        maxTime: z.union([z.number(), z.string()]).optional(),
      }),
    ])
    .optional(),
  simulateOnly: z.boolean().optional().default(false),
  baseFee: z.number().optional(),
});

export type TransactionBuilderInput = z.infer<typeof TransactionBuilderInputSchema>;

export interface TransactionBuilderResult {
  txHash?: string | undefined;
  ledger?: number | undefined;
  xdr: string;
  operationsCount: number;
}

function parseAsset(assetInput: unknown): Asset {
  if (!assetInput) return Asset.native();
  if (assetInput instanceof Asset) return assetInput;
  if (typeof assetInput === 'string') {
    if (assetInput === 'XLM' || assetInput === 'native') return Asset.native();
    const parts = assetInput.split(':');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return new Asset(parts[0], parts[1]);
    }
  }
  if (typeof assetInput === 'object' && assetInput !== null) {
    const obj = assetInput as {
      code?: string;
      assetCode?: string;
      issuer?: string;
      assetIssuer?: string;
    };
    const code = obj.code ?? obj.assetCode;
    const issuer = obj.issuer ?? obj.assetIssuer;
    if (!code || code === 'XLM' || !issuer) {
      return Asset.native();
    }
    return new Asset(code, issuer);
  }
  return Asset.native();
}

/**
 * Resolves an AgentTask to its corresponding Stellar SDK xdr.Operation object.
 */
export function taskToOperation(task: AgentTask | Record<string, unknown>): xdr.Operation {
  const type = String((task as any).type ?? '');
  const payload = (((task as any).payload ?? task) || {}) as Record<string, any>;

  switch (type) {
    case 'stellar_payment':
    case 'payment': {
      const destination = String(payload.destination);
      const amount = String(payload.amount);
      const asset =
        payload.assetCode && payload.assetCode !== 'XLM' && payload.assetIssuer
          ? new Asset(String(payload.assetCode), String(payload.assetIssuer))
          : parseAsset(payload.asset);

      return Operation.payment({
        destination,
        asset,
        amount,
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'change_trust': {
      const asset =
        payload.assetCode && payload.assetIssuer
          ? new Asset(String(payload.assetCode), String(payload.assetIssuer))
          : parseAsset(payload.asset);

      const limit =
        payload.action === 'remove'
          ? '0'
          : payload.limit !== undefined
            ? String(payload.limit)
            : undefined;

      return Operation.changeTrust({
        asset,
        ...(limit !== undefined ? { limit } : {}),
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'dex_offer': {
      const selling = parseAsset(payload.selling);
      const buying = parseAsset(payload.buying);
      const action = payload.action;
      const amount = action === 'delete' ? '0' : String(payload.amount);
      const price = String(payload.price);
      const offerId = payload.offerId !== undefined ? String(payload.offerId) : '0';

      return Operation.manageSellOffer({
        selling,
        buying,
        amount,
        price,
        offerId,
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'path_payment':
    case 'path_payment_strict_receive': {
      const sendAsset = parseAsset(
        payload.sendAsset ?? { code: payload.sendAssetCode, issuer: payload.sendAssetIssuer }
      );
      const destAsset = parseAsset(
        payload.destAsset ?? { code: payload.destAssetCode, issuer: payload.destAssetIssuer }
      );
      const path = Array.isArray(payload.path) ? payload.path.map(parseAsset) : [];

      return Operation.pathPaymentStrictReceive({
        sendAsset,
        sendMax: String(payload.sendMax),
        destination: String(payload.destination),
        destAsset,
        destAmount: String(payload.destAmount),
        path,
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'path_payment_strict_send': {
      const sendAsset = parseAsset(payload.sendAsset);
      const destAsset = parseAsset(payload.destAsset);
      const path = Array.isArray(payload.path) ? payload.path.map(parseAsset) : [];

      return Operation.pathPaymentStrictSend({
        sendAsset,
        sendAmount: String(payload.sendAmount),
        destination: String(payload.destination),
        destAsset,
        destMin: String(payload.destMin),
        path,
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'create_account': {
      return Operation.createAccount({
        destination: String(payload.destination),
        startingBalance: String(payload.startingBalance),
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'account_merge': {
      return Operation.accountMerge({
        destination: String(payload.destination),
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'manage_data': {
      return Operation.manageData({
        name: String(payload.name),
        value: payload.value as string | Buffer | null,
        ...(payload.source ? { source: String(payload.source) } : {}),
      });
    }

    case 'set_options': {
      return Operation.setOptions(payload as any);
    }

    case 'soroban_invoke': {
      const contractId = String(payload.contractId);
      const method = String(payload.method);
      const args = Array.isArray(payload.args) ? (payload.args as xdr.ScVal[]) : [];
      const contract = new Contract(contractId);
      return contract.call(method, ...args);
    }

    default:
      if (
        typeof (payload as any).type === 'string' &&
        typeof (Operation as any)[(payload as any).type] === 'function'
      ) {
        return (Operation as any)[(payload as any).type](payload);
      }
      throw new Error(`Unsupported task type for multi-op transaction builder: ${String(type)}`);
  }
}

export class TransactionBuilderTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(rawInput: unknown): Promise<TransactionBuilderResult> {
    const input = TransactionBuilderInputSchema.parse(rawInput);
    const operations: xdr.Operation[] = input.operations.map(taskToOperation);

    const sourceAccount = await loadAccount(this.keypair.publicKey());
    const baseFee = input.baseFee ?? Number(BASE_FEE);
    const totalFee = baseFee * Math.max(1, operations.length);

    const builderOpts: TransactionBuilder.TransactionBuilderOptions = {
      fee: totalFee.toString(),
      networkPassphrase: this.networkPassphrase,
    };

    if (typeof input.timeBounds === 'object') {
      const minTime = input.timeBounds.minTime !== undefined ? Number(input.timeBounds.minTime) : 0;
      const maxTime = input.timeBounds.maxTime !== undefined ? Number(input.timeBounds.maxTime) : 0;
      builderOpts.timebounds = { minTime, maxTime };
    }

    let builder = new TransactionBuilder(sourceAccount, builderOpts);

    if (input.memo) {
      if (input.memo instanceof Memo) {
        builder = builder.addMemo(input.memo);
      } else if (typeof input.memo === 'string') {
        builder = builder.addMemo(Memo.text(input.memo));
      } else if (typeof input.memo === 'object') {
        const { type = 'text', value } = input.memo;
        switch (type) {
          case 'text':
            builder = builder.addMemo(Memo.text(String(value)));
            break;
          case 'id':
            builder = builder.addMemo(Memo.id(String(value)));
            break;
          case 'hash':
            builder = builder.addMemo(Memo.hash(String(value)));
            break;
          case 'return':
            builder = builder.addMemo(Memo.return(String(value)));
            break;
        }
      }
    }

    if (typeof input.timeBounds === 'number') {
      builder = builder.setTimeout(input.timeBounds);
    } else if (!builderOpts.timebounds) {
      builder = builder.setTimeout(SOROBAN_TX_TIMEOUT);
    }

    for (const op of operations) {
      builder = builder.addOperation(op);
    }

    const tx = builder.build();
    const xdrBase64 = tx.toEnvelope().toXDR('base64');

    if (input.simulateOnly) {
      logger.info('Transaction simulated (multi_op simulateOnly)', {
        operationsCount: operations.length,
      });
      return {
        xdr: xdrBase64,
        operationsCount: operations.length,
      };
    }

    tx.sign(this.keypair);
    logger.info('Submitting multi_op transaction', {
      operationsCount: operations.length,
      source: this.keypair.publicKey(),
    });

    const result = await submitTransaction(tx);
    return {
      txHash: (result as any).hash,
      ledger: (result as any).ledger,
      xdr: xdrBase64,
      operationsCount: operations.length,
    };
  }
}
