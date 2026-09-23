/**
 * tests/helpers/MockNetworkConditions.ts
 *
 * MockNetworkConditions utility for injecting network latency and intermittent
 * failures into Vitest tests (#443).
 *
 * Wraps Vitest spy/mock APIs to inject delay (latencyMs) and/or errors (failureRate, errorType)
 * into configured call targets, with full support for Vitest fake timers and easy reset().
 */

import { vi, type MockInstance } from 'vitest';
import * as rpcClient from '../../backend/rpc_client';

export type ErrorTypeOption = string | Error | (() => Error);

export interface MockNetworkConditionsOptions {
  /** Injected network latency in milliseconds. Compatible with fake timers. */
  latencyMs?: number;
  /**
   * Probability of failure per call. Can be specified as a fraction (0.0 to 1.0)
   * or as a percentage (1 to 100).
   */
  failureRate?: number;
  /** Error message, Error instance, or factory function to throw on failure. */
  errorType?: ErrorTypeOption;
  /** Specific call target to apply conditions to. */
  target?: any;
  /** Specific call targets to apply conditions to. */
  targets?: any[];
}

type RestoreFn = () => void;

const restoreActions: RestoreFn[] = [];
let defaultRegisteredTargets: any[] = [];

/**
 * Configure default call targets that subsequent applyConditions() calls will wrap.
 */
export function configureTargets(targets: any | any[]): void {
  const targetArray = Array.isArray(targets) ? targets : [targets];
  defaultRegisteredTargets = [...targetArray];
}

/**
 * Helper to determine whether an error should be thrown based on failureRate.
 */
function shouldInjectFailure(failureRate?: number): boolean {
  if (failureRate === undefined || failureRate <= 0) return false;
  const rate = failureRate > 1 ? failureRate / 100 : failureRate;
  return Math.random() < rate;
}

/**
 * Helper to construct the Error to throw based on errorType.
 */
function buildInjectedError(errorType?: ErrorTypeOption): Error {
  if (!errorType) {
    const defaultErr = new Error('Network error: injected failure by MockNetworkConditions');
    defaultErr.name = 'NetworkError';
    return defaultErr;
  }
  if (typeof errorType === 'function') {
    return errorType();
  }
  if (errorType instanceof Error) {
    return errorType;
  }
  const customErr = new Error(errorType);
  customErr.name = errorType;
  return customErr;
}

/**
 * Wrap a single call target with latency and failure rate injection.
 */
function wrapTarget(target: any, options: MockNetworkConditionsOptions): void {
  if (!target) return;

  const { latencyMs = 0, failureRate = 0, errorType } = options;

  // Case 1: Tuple [object, methodName]
  if (Array.isArray(target) && target.length === 2 && typeof target[0] === 'object') {
    const [obj, method] = target;
    const spy = vi.spyOn(obj, method as any);
    const originalImpl = (spy as any).getMockImplementation?.();

    spy.mockImplementation(async (...args: unknown[]) => {
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      if (shouldInjectFailure(failureRate)) {
        throw buildInjectedError(errorType);
      }
      if (originalImpl) {
        return originalImpl.apply(obj, args);
      }
      return undefined;
    });

    restoreActions.push(() => {
      spy.mockRestore();
    });
    return;
  }

  // Case 2: Vitest mock function (vi.fn() or mocked property)
  if (typeof target === 'function' && vi.isMockFunction(target)) {
    const originalImpl = target.getMockImplementation();

    restoreActions.push(() => {
      if (originalImpl) {
        target.mockImplementation(originalImpl);
      } else {
        target.mockReset();
      }
    });

    target.mockImplementation(async (...args: unknown[]) => {
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }
      if (shouldInjectFailure(failureRate)) {
        throw buildInjectedError(errorType);
      }
      if (originalImpl) {
        return originalImpl(...args);
      }
      return undefined;
    });
    return;
  }

  // Case 3: Plain object containing mock functions (e.g. MockHorizonServer or rpc_client)
  if (typeof target === 'object') {
    const candidateKeys = ['submitTransaction', 'loadAccount', 'simulateSorobanTx'];
    for (const key of candidateKeys) {
      if (typeof target[key] === 'function') {
        wrapTarget(target[key], options);
      }
    }
  }
}

/**
 * Apply network conditions (latency, failure rate, error type) to call targets.
 *
 * If targets are not specified in options, any targets registered via configureTargets()
 * are used. If none are configured, defaults to rpcClient.submitTransaction.
 */
export function applyConditions(options: MockNetworkConditionsOptions = {}): void {
  // Clear any existing active wrappers before applying new conditions
  resetWrappers();

  let targetList: any[] = [];
  if (options.targets && Array.isArray(options.targets)) {
    targetList = [...options.targets];
  } else if (options.target) {
    targetList = [options.target];
  } else if (defaultRegisteredTargets.length > 0) {
    targetList = [...defaultRegisteredTargets];
  } else {
    // Default to rpcClient mocks if available
    if (rpcClient && typeof (rpcClient as any).submitTransaction === 'function') {
      targetList.push((rpcClient as any).submitTransaction);
    }
  }

  for (const target of targetList) {
    wrapTarget(target, options);
  }
}

/**
 * Reset active condition wrappers, restoring original implementations without clearing configured targets.
 */
function resetWrappers(): void {
  while (restoreActions.length > 0) {
    const restore = restoreActions.pop();
    if (restore) {
      try {
        restore();
      } catch {
        // ignore errors during restoration
      }
    }
  }
}

/**
 * Restore original behaviour on all wrapped targets and clear state.
 */
export function reset(): void {
  resetWrappers();
  defaultRegisteredTargets = [];
}

export const MockNetworkConditions = {
  applyConditions,
  reset,
  configureTargets,
};
