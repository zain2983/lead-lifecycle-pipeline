// HubSpot OAuth, webhook verification, token crypto and signed replay. Phase 3 adds the rate-limited
// client, token refresh and property setup.
export {
  type AuthorizeUrlInput,
  buildAuthorizeUrl,
  type ExchangeCodeInput,
  exchangeAuthorizationCode,
  HUBSPOT_AUTHORIZE_URL,
  HUBSPOT_REQUIRED_SCOPES,
  HUBSPOT_TOKEN_URL,
  HubSpotOAuthError,
  type HubSpotTokens,
} from "./oauth.ts";
export {
  MAX_TIMESTAMP_SKEW_MS,
  normalizeSignedUri,
  REQUEST_TIMESTAMP_HEADER,
  SIGNATURE_V3_HEADER,
  type SignatureV3Failure,
  type SignatureV3Input,
  type SignatureV3Result,
  signatureV3,
  signedUriFor,
  type VerifySignatureV3Input,
  verifySignatureV3,
} from "./signature.ts";
export {
  decryptSecret,
  type EncryptedSecret,
  encryptSecret,
  parseEncryptionKey,
  refreshTokenAad,
  TokenCryptoError,
} from "./token-crypto.ts";
export {
  type HubSpotWebhookEvent,
  type ParseWebhookBatchResult,
  parseWebhookBatch,
  webhookBatchSchema,
  webhookEventSchema,
} from "./webhook-events.ts";
