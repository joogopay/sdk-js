# Direct API integration

The SDK is optional. You may implement the protocol in your own framework, using any approved crypto implementation that passes the shared vectors. The platform validates HTTP requests, not which client library produced them. A different library must still implement Ed25519, the fixed RFC 9421 profile and the complete X25519/XSalsa20-Poly1305 sealed-box construction.

## Runtime and dependencies

Java 8's default crypto providers do not provide the required primitives; JDK 17 adds Ed25519 and X25519 but still does not provide the complete sealed box. The full Java SDK supports Java 8, 11, 17 and 21. The Java distribution includes an `examples/java8` adapter that keeps your existing HTTP and JSON libraries and uses Bouncy Castle's lightweight API without native code or global provider registration. Other approved implementations are allowed. Review the library version and the adapter's composition code under your own dependency policy.

For other runtimes, check that the sodium extension, binding or compatible implementation is available in the deployed environment. An algorithm name in a library does not by itself establish sealed-box compatibility.

## Implementation sequence

1. Generate the merchant Ed25519 key pair locally and register only its public key. Obtain the access key, platform body public key/id, webhook public keys/ids and API URL through the platform's onboarding process. Never share the merchant private key.
2. Implement [request signing](./signature.md), including the strict header rules. Test a GET signature against `testdata/signature/` before sending a balance query in the test environment.
3. Implement [body encryption](./body-encryption.md). Encrypt first, serialize the envelope once, digest and sign those exact bytes, then send them unchanged. Compare fixed signatures; test randomized encryption by opening the ciphertext, not by expecting identical output.
4. Implement [webhook verification and processing](./webhook.md). Preserve raw bytes, verify first, establish order ownership, then update state or reliably queue the event.
5. Test create, query, webhook retries and recovery from unknown outcomes. Preserve `merchantOrderNo` during recovery and generate a new signature for every HTTP attempt. POST `Idempotency-Key` is request metadata, not the business deduplication key.

## Troubleshooting

| Symptom | Check |
|---|---|
| Every POST returns 401 | Exact `application/json` without charset; no gzip; lowercase UUID v4; correct envelope algorithm and body key id |
| GET fails for encoded characters | Sign the final raw query exactly as the HTTP client sends it |
| Digest or signature differs | Final wire body bytes, component order, header values and no trailing newline in the signature base |
| Retry returns 401 | Fresh nonce and timestamps on every attempt; the same business order number |
| Webhook fails verification | Raw body, public key selected by keyid, received path/query and clock |

Keep the response trace id for support. Do not include private keys or sensitive business payloads in diagnostic logs. Passing offline vectors establishes protocol compatibility; actual client/proxy behavior and business recovery still need test-environment validation.
