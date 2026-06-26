// Skyreader's own atproto identity (handle skyreader.app). This is the repo where
// Skyreader publishes its dev.at-intent.capability records, the `app` value written into
// users' dev.at-intent.usage footprints, AND the expected `aud` of an atproto service-auth
// JWT presented to Skyreader's XRPC endpoints. Resolve with:
//   curl https://skyreader.app/.well-known/atproto-did
export const SKYREADER_APP_DID = 'did:plc:ra4jsemddo2ii4pn5jaf6x4v';
