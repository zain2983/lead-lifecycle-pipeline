// Test doubles. Nothing these return is a HubSpot response.

export {
  type FakeAnswer,
  type FakeContact,
  type FakeHubSpot,
  type FakeHubSpotOptions,
  type FakeProperty,
  type FakeRequest,
  startFakeHubSpot,
} from "./fake-hubspot.ts";
export {
  type FakeTokenHandler,
  type FakeTokenRequest,
  startFakeTokenServer,
  syntheticTokenResponse,
} from "./fake-token-server.ts";
