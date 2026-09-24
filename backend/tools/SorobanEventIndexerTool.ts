/**
 * backend/tools/SorobanEventIndexerTool.ts
 * Query historical Soroban contract events by ledger range.
 */

import { rpc } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { sorobanServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';

export const SorobanEventIndexerInputSchema = z.object({
  contractId: z
    .string()
    .length(56)
    .regex(/^C[A-Z2-7]+$/, 'Invalid Stellar contract ID'),
  fromLedger: z.number().int().positive(),
  toLedger: z.number().int().positive(),
  topics: z.array(z.array(z.string())).optional(),
});

export type SorobanEventIndexerInput = z.infer<typeof SorobanEventIndexerInputSchema>;

export interface SorobanEventIndexerResult {
  events: rpc.Api.EventResponse[];
  latestLedger: number;
}

export class SorobanEventIndexerTool {
  async query(rawInput: unknown): Promise<SorobanEventIndexerResult> {
    const input = SorobanEventIndexerInputSchema.parse(rawInput);

    if (input.fromLedger > input.toLedger) {
      throw new Error('fromLedger must be less than or equal to toLedger');
    }

    const filters: rpc.Api.EventFilter[] = [
      {
        type: 'contract',
        contractIds: [input.contractId],
        ...(input.topics ? { topics: input.topics } : {}),
      },
    ];

    const response = await withBackoffGuard(() =>
      withRetry(
        () =>
          sorobanServer.getEvents({
            startLedger: input.fromLedger,
            endLedger: input.toLedger,
            filters,
          } as rpc.Server.GetEventsRequest),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    return {
      events: response.events,
      latestLedger: response.latestLedger ?? input.toLedger,
    };
  }
}
