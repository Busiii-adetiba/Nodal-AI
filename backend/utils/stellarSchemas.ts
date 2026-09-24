/**
 * Shared Zod schemas for Stellar strkey addresses (Issue #567).
 *
 * Seventeen tool files each defined their own `z.string().length(56, …)`, and
 * only nine of them went on to verify the Ed25519 checksum. In the other eight
 * a right-shaped address with a corrupted character passed input validation
 * and failed later as an opaque SDK or network error — which is both harder to
 * act on and much further from the mistake that caused it.
 *
 * The checksum is the whole point of strkey: it is what turns a mistyped
 * address into a validation error instead of a payment to nowhere. Length and
 * a prefix character catch neither a transposition nor a single wrong letter.
 *
 * # Why two schemas, not one
 *
 * Three of those seventeen fields are contract IDs (`C…`), not account public
 * keys (`G…`). They share the 56-character length and nothing else: a contract
 * ID checked with `isValidEd25519PublicKey` would be rejected outright. They
 * get their own schema rather than being folded in.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

/** Length of every strkey-encoded Stellar address. */
export const STRKEY_LENGTH = 56;

/** Whether a string is a valid Ed25519 account public key (`G…`). */
export function isValidStellarPublicKey(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

/** Whether a string is a valid contract address (`C…`). */
export function isValidStellarContractId(value: string): boolean {
  return StrKey.isValidContract(value);
}

/**
 * A Stellar account public key.
 *
 * `label` names the field in the failure message, so a rejected multi-sig
 * request says which signer was wrong rather than "Invalid Stellar public
 * key" repeated once per entry.
 *
 * Checks run in order — length, prefix, then checksum — so the message a
 * caller gets describes the first thing that is actually wrong.
 */
export function stellarPublicKeySchema(label = 'Stellar public key') {
  return z
    .string()
    .length(STRKEY_LENGTH, `${label} must be ${STRKEY_LENGTH} characters`)
    .refine((val) => val.startsWith('G'), {
      message: `${label} must start with G`,
    })
    .refine(isValidStellarPublicKey, {
      // Deliberately explicit about the checksum: "invalid" alone reads as
      // "wrong account", when the usual cause is one mistyped character.
      message: `${label} is not a valid Stellar public key (checksum failed)`,
    });
}

/** A Stellar contract address (`C…`). */
export function stellarContractIdSchema(label = 'Stellar contract ID') {
  return z
    .string()
    .length(STRKEY_LENGTH, `${label} must be ${STRKEY_LENGTH} characters`)
    .refine((val) => val.startsWith('C'), {
      message: `${label} must start with C`,
    })
    .refine(isValidStellarContractId, {
      message: `${label} is not a valid Stellar contract ID (checksum failed)`,
    });
}

/** Default instances, for the common case where the label adds nothing. */
export const StellarPublicKeySchema = stellarPublicKeySchema();
export const StellarContractIdSchema = stellarContractIdSchema();
