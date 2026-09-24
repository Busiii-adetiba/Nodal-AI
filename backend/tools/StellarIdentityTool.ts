/**
 * backend/tools/StellarIdentityTool.ts
 * SEP-0010 Web Auth challenge-response for anchor authentication.
 */

import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';
import { createLogger } from '../utils/logger';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

const log = createLogger('stellar-identity');

const ChallengeResponseSchema = z.object({
  transaction: z.string().min(1),
  network_passphrase: z.string().min(1),
});

const AuthResponseSchema = z.object({
  token: z.string().min(1),
});

export const WebAuthInputSchema = z.object({
  anchorUrl: z.string().url(),
  publicKey: stellarPublicKeySchema('publicKey').optional(),
});

export type WebAuthInput = z.infer<typeof WebAuthInputSchema>;

export interface WebAuthResult {
  token: string;
}

export class StellarIdentityTool {
  private keypair: Keypair;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
  }

  async getChallenge(
    anchorUrl: string,
    publicKey: string
  ): Promise<{ transaction: string; networkPassphrase: string }> {
    const baseUrl = anchorUrl.replace(/\/$/, '');
    const url = `${baseUrl}/auth?account=${encodeURIComponent(publicKey)}`;
    const response = await withBackoffGuard(() =>
      withRetry(() => fetch(url), config.MAX_RETRIES, config.RETRY_DELAY_MS)
    );

    if (!response.ok) {
      throw new Error(`SEP-0010 challenge request failed: HTTP ${response.status}`);
    }

    const body = ChallengeResponseSchema.parse(await response.json());
    return {
      transaction: body.transaction,
      networkPassphrase: body.network_passphrase,
    };
  }

  async execute(rawInput: unknown): Promise<WebAuthResult> {
    const input = WebAuthInputSchema.parse(rawInput);
    const publicKey = input.publicKey ?? this.keypair.publicKey();
    const baseUrl = input.anchorUrl.replace(/\/$/, '');

    log.info({ anchorUrl: baseUrl, publicKey }, 'Starting SEP-0010 web auth');

    const challenge = await this.getChallenge(baseUrl, publicKey);
    const tx = new Transaction(challenge.transaction, challenge.networkPassphrase);
    tx.sign(this.keypair);
    const signedXdr = tx.toXDR();

    const response = await withBackoffGuard(() =>
      withRetry(
        () =>
          fetch(`${baseUrl}/auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transaction: signedXdr }),
          }),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    if (!response.ok) {
      throw new Error(`SEP-0010 auth submission failed: HTTP ${response.status}`);
    }

    const { token } = AuthResponseSchema.parse(await response.json());
    log.info({ anchorUrl: baseUrl, publicKey }, 'SEP-0010 web auth completed');

    return { token };
  }
}
