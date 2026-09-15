# Request signing (Ed25519, RFC 9421)

Every merchant request is signed with the merchant's Ed25519 key using
[RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421). The
merchant holds the private key; the platform holds the public key.

## Headers

| Header | Present on | Value |
|---|---|---|
| `Merchant-Access-Key` | write, read | public access identifier |
| `Content-Type` | write | `application/json` |
| `Content-Encryption` | write | `sealedbox-v1-x25519-xsalsa20poly1305` |
| `Content-Digest` | write | `sha-256=:<base64(sha256(wire-body))>:` (RFC 9530) |
| `Idempotency-Key` | write | UUID v4, fresh per request; carried for tracing, never used for deduplication |
| `Signature-Input` | write, read | `merchant=(<components>);created=…;expires=…;nonce="…";alg="ed25519"` |
| `Signature` | write, read | `merchant=:<base64(ed25519-signature)>:` |

`Content-Encoding` must be absent or `identity`.

## Covered components

Write (POST):

```text
("@method" "@path" "content-type" "content-encryption" "content-digest" "idempotency-key" "merchant-access-key")
```

Read (GET):

```text
("@method" "@path" "@query" "merchant-access-key")
```

The gateway accepts exactly these component sets and no other. `@query` is
`"?" + raw-query` (RFC 9421 §2.2.8), signed verbatim without reordering.

## Signature parameters

| Param | Value |
|---|---|
| `created` | Unix seconds at signing time |
| `expires` | `created + 300`; the accepted lifetime is at most 300 s |
| `nonce` | UUID v4, regenerated for every HTTP request (replay protection) |
| `alg` | `ed25519` |

## Signature base

One line per covered component, then the parameters line, joined with `\n` and
**no trailing newline**. Each component name is quoted; the last line is
`"@signature-params"` with the value from `Signature-Input` (without the label):

```text
"@method": POST
"@path": /api/v1/payments
"content-type": application/json
"content-encryption": sealedbox-v1-x25519-xsalsa20poly1305
"content-digest": sha-256=:<base64>:
"idempotency-key": <uuid>
"merchant-access-key": <access-key>
"@signature-params": ("@method" "@path" "content-type" "content-encryption" "content-digest" "idempotency-key" "merchant-access-key");created=…;expires=…;nonce="…";alg="ed25519"
```

The signature is `ed25519.Sign(privateKey, signatureBase)`, base64-encoded and
wrapped as `merchant=:<base64>:`.

## Verification order (gateway)

1. Request shape: fixed method, required/forbidden headers, single-valued headers.
2. `Content-Digest` recomputed over the wire body.
3. `Signature-Input` parsed; parameters validated (alg, nonce is UUID v4,
   freshness within the window, covered components match).
4. Signature verified against the merchant public key over the reconstructed base.
5. Nonce marked as used only after the signature verifies.

Fixed vectors: [`testdata/signature/`](./testdata/signature/).
