import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
  refreshTokenAad,
  TokenCryptoError,
} from "../src/token-crypto.ts";

const key = randomBytes(32);
const token = "na1-0000-synthetic-refresh-token-0001";
const aad = refreshTokenAad(900000001n);

function flipFirstByte(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[0] = (copy[0] ?? 0) ^ 0x01;
  return copy;
}

describe("token crypto (AES-256-GCM)", () => {
  it("round-trips a refresh token", () => {
    const encrypted = encryptSecret(token, key, aad);
    expect(Buffer.from(encrypted.ciphertext).toString("utf8")).not.toContain("refresh");
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(decryptSecret(encrypted, key, aad)).toBe(token);
  });

  it("uses a fresh IV every time", () => {
    const a = encryptSecret(token, key, aad);
    const b = encryptSecret(token, key, aad);
    expect(Buffer.from(a.iv).equals(Buffer.from(b.iv))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  it("fails on a tampered ciphertext", () => {
    const encrypted = encryptSecret(token, key, aad);
    expect(() =>
      decryptSecret({ ...encrypted, ciphertext: flipFirstByte(encrypted.ciphertext) }, key, aad),
    ).toThrowError(TokenCryptoError);
  });

  it("fails on a tampered auth tag or IV", () => {
    const encrypted = encryptSecret(token, key, aad);
    expect(() =>
      decryptSecret({ ...encrypted, authTag: flipFirstByte(encrypted.authTag) }, key, aad),
    ).toThrowError(TokenCryptoError);
    expect(() =>
      decryptSecret({ ...encrypted, iv: flipFirstByte(encrypted.iv) }, key, aad),
    ).toThrowError(TokenCryptoError);
  });

  it("fails with the wrong key", () => {
    const encrypted = encryptSecret(token, key, aad);
    expect(() => decryptSecret(encrypted, randomBytes(32), aad)).toThrowError(TokenCryptoError);
  });

  it("fails when the ciphertext is moved to another portal's row", () => {
    const encrypted = encryptSecret(token, key, aad);
    expect(() => decryptSecret(encrypted, key, refreshTokenAad(900000002n))).toThrowError(
      TokenCryptoError,
    );
  });

  it("checks the key from TOKEN_ENCRYPTION_KEY", () => {
    expect(parseEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(() => parseEncryptionKey(randomBytes(16).toString("base64"))).toThrowError(/32 bytes/);
    expect(() => encryptSecret(token, randomBytes(31))).toThrowError(/32 bytes/);
  });
});
