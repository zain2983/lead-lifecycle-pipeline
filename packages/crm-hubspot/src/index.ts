// HubSpot OAuth, webhook verification, token crypto, signed replay and the service-key REST client.
// Phase 3 adds token refresh and the typed client.
export {
  type ClientStats,
  DEFAULT_RATE_LIMIT,
  HUBSPOT_API_BASE_URL,
  HUBSPOT_API_VERSION,
  HubSpotApiError,
  HubSpotClient,
  type HubSpotClientOptions,
  HubSpotOutcomeUnknownError,
  type HubSpotRequest,
  type HubSpotResponse,
} from "./api.ts";
export { crmEventDedupeKey } from "./crm-event-key.ts";
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
