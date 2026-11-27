import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (the HubSpot refresh token). The key is `TOKEN_ENCRYPTION_KEY`:
 * 32 random bytes, base64 (`openssl rand -base64 32`). Every encryption uses a fresh 96-bit IV, and GCM's
 * 128-bit auth tag makes any change to the ciphertext, IV, tag or associated data fail on decrypt.
 *
 * `aad` (associated data) is authenticated but not stored in the ciphertext. Binding it to the row's
 * portal ID means a ciphertext copied into another portal's row won't decrypt.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedSecret {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
}

export class TokenCryptoError extends Error {
  override name = "TokenCryptoError";
}

/** Decode and check `TOKEN_ENCRYPTION_KEY`. */
export function parseEncryptionKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(`encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Uint8Array, aad?: string): EncryptedSecret {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Throws `TokenCryptoError` if the key is wrong or anything was tampered with. */
export function decryptSecret(secret: EncryptedSecret, key: Uint8Array, aad?: string): string {
  checkKey(key);
  if (secret.iv.length !== IV_BYTES || secret.authTag.length !== TAG_BYTES) {
    throw new TokenCryptoError("malformed encrypted secret (IV or auth tag length)");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, secret.iv, { authTagLength: TAG_BYTES });
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(secret.authTag);
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    // Node reports "Unsupported state or unable to authenticate data". Don't echo anything else.
    throw new TokenCryptoError("could not decrypt secret: wrong key or tampered data", { cause });
  }
}

/** Associated data for a portal's refresh token. Bump `v1` if the stored format changes. */
export function refreshTokenAad(portalId: bigint | number): string {
  return `hubspot-refresh-token:v1:${portalId}`;
}

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(`encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}
