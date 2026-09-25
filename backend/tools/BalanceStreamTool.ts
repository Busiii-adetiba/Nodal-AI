/**
 * backend/tools/BalanceStreamTool.ts
 * Streaming balance change monitor tool via Horizon's SSE /effects endpoint.
 *
 * Features automatic reconnection with exponential backoff on stream errors,
 * similar to ContractEventListener's pattern.
 */

import { EventEmitter } from 'events';
import { horizonServer } from '../rpc_client';
import { logger } from '../logger';
import { config } from '../config';

export type BalanceDirection = 'credit' | 'debit';

export interface BalanceEvent {
  assetCode: string;
  amount: string;
  direction: BalanceDirection;
}

export interface BalanceStreamOptions {
  /** Maximum reconnect attempts before giving up. Default: 5 */
  maxReconnectAttempts?: number;
  /** Base polling interval for reconnection in ms. Default: 2000 */
  pollIntervalMs?: number;
  /** Optional callback invoked when all reconnect attempts are exhausted */
  onError?: (error: Error) => void;
}

export class BalanceStreamTool {
  private closeStreamFn: (() => void) | null = null;
  private emitter: EventEmitter = new EventEmitter();
  private currentPublicKey: string | null = null;
  private options: BalanceStreamOptions = {};
  private reconnectAttempts = 0;
  private isStopped = false;
  private reconnectTimerId: NodeJS.Timeout | undefined;

  /**
   * Subscribes to account payment effects via Horizon's SSE /effects endpoint.
   * Emits typed BalanceEvent objects on the returned EventEmitter.
   *
   * Features automatic reconnection with exponential backoff on stream errors.
   *
   * @param publicKey - Stellar public key (G...)
   * @param options - Optional reconnection configuration
   * @returns EventEmitter emitting 'balance' events with BalanceEvent object
   */
  subscribe(publicKey: string, options?: BalanceStreamOptions): EventEmitter {
    // Stop any existing stream before starting a new one
    this.stop();

    this.currentPublicKey = publicKey;
    this.options = options ?? {};
    this.reconnectAttempts = 0;
    this.isStopped = false;

    this.startStream(publicKey);

    return this.emitter;
  }

  /**
   * Start the SSE stream for the given public key.
   */
  private startStream(publicKey: string): void {
    if (this.isStopped || !publicKey) return;

    this.closeStreamFn = horizonServer
      .effects()
      .forAccount(publicKey)
      .stream({
        onmessage: (effect: any) => {
          // Reset reconnect attempts on successful message
          this.reconnectAttempts = 0;

          if (effect.type === 'account_credited') {
            const assetCode = effect.asset_type === 'native' ? 'XLM' : effect.asset_code || 'XLM';
            const event: BalanceEvent = {
              assetCode,
              amount: effect.amount,
              direction: 'credit',
            };
            this.emitter.emit('balance', event);
          } else if (effect.type === 'account_debited') {
            const assetCode = effect.asset_type === 'native' ? 'XLM' : effect.asset_code || 'XLM';
            const event: BalanceEvent = {
              assetCode,
              amount: effect.amount,
              direction: 'debit',
            };
            this.emitter.emit('balance', event);
          }
        },
        onerror: (error: any) => {
          this.handleStreamError(error, publicKey);
        },
      });
  }

  /**
   * Handle stream error with reconnection logic.
   */
  private handleStreamError(error: any, publicKey: string): void {
    if (this.isStopped) return;

    // Close the failed stream
    if (this.closeStreamFn) {
      this.closeStreamFn();
      this.closeStreamFn = null;
    }

    this.reconnectAttempts++;
    const maxReconnectAttempts = this.options.maxReconnectAttempts ?? 5;

    logger.warn('BalanceStreamTool stream error, attempting reconnect', {
      publicKey,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts,
      error: error?.message ?? String(error),
    });

    if (this.reconnectAttempts >= maxReconnectAttempts) {
      // All reconnect attempts exhausted
      this.isStopped = true;

      // Emit custom 'connectionError' instead of 'error' to avoid process crash
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitter.emit('connectionError', err);

      // Call optional onError callback if provided
      if (this.options.onError) {
        try {
          this.options.onError(err);
        } catch (callbackErr) {
          logger.error('BalanceStreamTool onError callback threw', {
            publicKey,
            error: (callbackErr as Error).message,
          });
        }
      }

      return;
    }

    // Schedule reconnect with exponential backoff
    const baseDelay = this.options.pollIntervalMs ?? config.RETRY_DELAY_MS ?? 1000;
    const exponential = baseDelay * Math.pow(2, this.reconnectAttempts - 1);
    const backoffDelay = Math.min(exponential, 30_000);

    this.reconnectTimerId = setTimeout(() => {
      if (!this.isStopped && this.currentPublicKey) {
        this.startStream(this.currentPublicKey);
      }
    }, backoffDelay);
  }

  /**
   * Cleanly closes the SSE stream and cancels any pending reconnect.
   */
  stop(): void {
    this.isStopped = true;

    if (this.reconnectTimerId) {
      clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = undefined;
    }

    if (this.closeStreamFn) {
      this.closeStreamFn();
      this.closeStreamFn = null;
    }

    this.currentPublicKey = null;
  }
}
