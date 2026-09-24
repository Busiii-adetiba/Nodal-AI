/**
 * backend/errors.ts
 *
 * Typed error classes for tool failures and system errors.
 * Allows callers to programmatically distinguish between error types
 * rather than relying on brittle string matching.
 */

export enum ErrorType {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  NetworkTimeout = 'NETWORK_TIMEOUT',
  ValidationError = 'VALIDATION_ERROR',
  RateLimitError = 'RATE_LIMIT_ERROR',
  UnauthorizedError = 'UNAUTHORIZED_ERROR',
  ContractError = 'CONTRACT_ERROR',
  /**
   * A simulation exceeded its resource budget (Issue #569).
   *
   * Separate from ContractError because the caller's response differs: a
   * budget overrun is retryable with a larger budget or a smaller call, while
   * a contract error usually is not. Sharing one type forced callers to
   * string-match the message, which is exactly what errorType exists to avoid.
   */
  SimulationBudgetExceeded = 'SIMULATION_BUDGET_EXCEEDED',
  TransactionFailure = 'TRANSACTION_FAILURE',
  ConfigError = 'CONFIG_ERROR',
  UnknownError = 'UNKNOWN_ERROR',
}

export class StructuredError extends Error {
  readonly errorType: ErrorType;
  readonly cause?: unknown;

  constructor(message: string, errorType: ErrorType, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
    this.cause = cause;
    Object.setPrototypeOf(this, StructuredError.prototype);
  }
}

export class InsufficientFundsError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.InsufficientFunds, cause);
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

export class NetworkTimeoutError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.NetworkTimeout, cause);
    Object.setPrototypeOf(this, NetworkTimeoutError.prototype);
  }
}

export class ValidationError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ValidationError, cause);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class RateLimitError extends StructuredError {
  readonly retryAfterSeconds?: number | undefined;

  constructor(message: string, retryAfterSeconds?: number, cause?: unknown) {
    super(message, ErrorType.RateLimitError, cause);
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class UnauthorizedError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.UnauthorizedError, cause);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class ContractError extends StructuredError {
  readonly contractId?: string | undefined;

  constructor(message: string, contractId?: string, cause?: unknown) {
    const isContractId =
      typeof contractId === 'string' && contractId.length === 56 && contractId.startsWith('C');
    const actualContractId = isContractId
      ? contractId
      : cause !== undefined
        ? contractId
        : undefined;
    const actualCause = cause !== undefined ? cause : isContractId ? undefined : contractId;

    super(message, ErrorType.ContractError, actualCause);
    this.contractId = actualContractId;
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

export class TransactionFailureError extends StructuredError {
  readonly txHash?: string | undefined;

  constructor(message: string, txHash?: string, cause?: unknown) {
    super(message, ErrorType.TransactionFailure, cause);
    this.txHash = txHash;
    Object.setPrototypeOf(this, TransactionFailureError.prototype);
  }
}

export class ConfigError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ConfigError, cause);
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

export class SimulationBudgetError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.SimulationBudgetExceeded, cause);
    Object.setPrototypeOf(this, SimulationBudgetError.prototype);
  }
}

function getErrorType(error: unknown): ErrorType {
  if (error instanceof StructuredError) {
    return error.errorType;
  }
  return ErrorType.UnknownError;
}

export { getErrorType };

const SENSITIVE_CAUSE_KEYS = new Set(['secretKey', 'privateKey', 'seed', '_secretKey']);

/**
 * Recursively strips keys that may carry Stellar signing material (secretKey,
 * privateKey, seed, _secretKey) from an error cause before it is attached to
 * a thrown error, so it can't be exfiltrated via JSON-serialised logs/webhooks.
 */
export function sanitizeCause(cause: unknown): unknown {
  if (Array.isArray(cause)) {
    return cause.map(sanitizeCause);
  }
  if (cause !== null && typeof cause === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(cause)) {
      if (SENSITIVE_CAUSE_KEYS.has(key)) continue;
      sanitized[key] = sanitizeCause(value);
    }
    return sanitized;
  }
  return cause;
}
