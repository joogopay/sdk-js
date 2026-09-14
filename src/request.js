/**
 * buildWrite / buildRead produce headers and the wire body without network I/O,
 * so they can be tested against the protocol vectors in isolation.
 */

import { RequestError } from './errors.js';
import * as p from './protocol.js';

/** Signed POST: sealed body envelope, Content-Digest and Ed25519 signature. */
export async function buildWrite({
  endpointUrl, accessKey, idempotencyKey, bodyKeyId, bodyPublicKey,
  merchantPrivateKey, body, nonce, now,
}) {
  if (!endpointUrl || !accessKey || !idempotencyKey || !bodyKeyId || !body?.length) {
    throw new RequestError('sdk: invalid signed request');
  }
  p.validateIdempotencyKey(idempotencyKey);

  const url = new URL(endpointUrl);
  if (url.search) throw new RequestError('sdk: signed POST query is not allowed');

  const wireBody = await p.sealBodyEnvelope(body, bodyPublicKey, bodyKeyId);
  const params = p.newMerchantWriteSignatureParams(nonce, now);

  const headers = {
    'Content-Type': 'application/json',
    [p.HEADER_CONTENT_ENCRYPTION]: p.CONTENT_ENCRYPTION,
    [p.HEADER_CONTENT_DIGEST]: p.contentDigestSha256(wireBody),
    [p.HEADER_IDEMPOTENCY_KEY]: idempotencyKey,
    [p.HEADER_MERCHANT_ACCESS_KEY]: accessKey,
  };
  headers[p.HEADER_SIGNATURE_INPUT] = p.signatureInputHeader(params);
  const base = p.signatureBase(params, {
    method: 'POST', path: url.pathname || '/', rawQuery: '', headers,
  });
  headers[p.HEADER_SIGNATURE] = await p.signEd25519(
    merchantPrivateKey, p.SIGNATURE_LABEL_MERCHANT, base,
  );
  return { method: 'POST', headers, body: wireBody };
}

/** Signed GET: no body and no idempotency key; the signature covers method, path, query and access key. */
export async function buildRead({ endpointUrl, accessKey, merchantPrivateKey, nonce, now }) {
  if (!endpointUrl || !accessKey) throw new RequestError('sdk: invalid signed request');

  const url = new URL(endpointUrl);
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  p.validateMerchantReadQuery(rawQuery);
  const params = p.newMerchantReadSignatureParams(nonce, now);

  const headers = { [p.HEADER_MERCHANT_ACCESS_KEY]: accessKey };
  headers[p.HEADER_SIGNATURE_INPUT] = p.signatureInputHeader(params);
  const base = p.signatureBase(params, {
    method: 'GET', path: url.pathname || '/', rawQuery, headers,
  });
  headers[p.HEADER_SIGNATURE] = await p.signEd25519(
    merchantPrivateKey, p.SIGNATURE_LABEL_MERCHANT, base,
  );
  return { method: 'GET', headers, body: null };
}
