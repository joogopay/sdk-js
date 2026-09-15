import { APIError, ConfigError, RequestError, ResponseError, ResponseTooLargeError, TransportError, WebhookError } from './errors.js';
import * as p from './protocol.js';
import { buildRead, buildWrite } from './request.js';
import { WEBHOOK_ORDER_TYPE_PAYMENT, WEBHOOK_ORDER_TYPE_PAYOUT } from './types.js';
import {
  validateCreateCommon, validatePathOrderNo, validatePaymentMethod, validatePayoutMethod,
} from './validate.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 << 20;
const DEFAULT_USER_AGENT = 'merchant-sdk-js';
const DEFAULT_ACCEPT_LANGUAGE = 'en-US';

function decodeKey(value, sizes, what) {
  const raw = Buffer.from(String(value ?? '').trim(), 'base64');
  if (!raw.length || !sizes.includes(raw.length)) throw new ConfigError(`sdk: invalid ${what}`);
  return raw;
}

/** Serialisation happens before signing, so a failure here is a request error, never a transport one. */
function encodeBody(body) {
  try {
    return Buffer.from(JSON.stringify(body), 'utf8');
  } catch (err) {
    throw new RequestError(`sdk: marshal request body: ${err.message}`);
  }
}

/**
 * Merchant open API client. Signing, digest and body encryption happen inside;
 * callers never touch Signature-Input, Content-Digest or the envelope.
 *
 * baseUrl is scheme and host only, https; a path is rejected because the SDK
 * appends the endpoint path itself.
 *
 * merchantPrivateKeyBase64 takes either form of Ed25519 private key: the 32-byte
 * seed libsodium and OpenSSL hand out, or the 64-byte seed plus public key.
 *
 * platformBodyKeyId names which platform key seals the request body and travels
 * in the envelope so the gateway knows which private key opens it; it must name
 * the key given in platformBodyPublicKeyBase64, which is X25519, not the Ed25519
 * webhook key.
 *
 * platformWebhookPublicKeys maps key id to platform Ed25519 public key and
 * verifies webhook signatures, the opposite direction. The webhook names its key
 * id, so this holds every key the platform may currently sign with; during a
 * rotation that is two. Required even without webhooks.
 */
export class Client {
  constructor({
    baseUrl,
    accessKey,
    merchantPrivateKeyBase64,
    platformBodyKeyId,
    platformBodyPublicKeyBase64,
    platformWebhookPublicKeys,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = DEFAULT_USER_AGENT,
    acceptLanguage = DEFAULT_ACCEPT_LANGUAGE,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    fetchImpl = globalThis.fetch,
    now = null,
  } = {}) {
    const trimmed = String(baseUrl ?? '').trim();
    if (!trimmed) throw new ConfigError('sdk: baseUrl is required');
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ConfigError('sdk: baseUrl must be an absolute origin URL');
    }
    if (url.protocol !== 'https:' || !url.host || url.search || url.hash) {
      throw new ConfigError('sdk: baseUrl must be an absolute origin URL');
    }
    if (url.pathname !== '' && url.pathname !== '/') {
      throw new ConfigError('sdk: baseUrl must not contain a path');
    }
    if (!String(accessKey ?? '').trim()) throw new ConfigError('sdk: accessKey is required');
    if (!String(platformBodyKeyId ?? '').trim()) {
      throw new ConfigError('sdk: platformBodyKeyId is required');
    }
    const webhookEntries = Object.entries(platformWebhookPublicKeys ?? {});
    if (!webhookEntries.length) {
      throw new ConfigError('sdk: platformWebhookPublicKeys is required');
    }

    this.baseUrl = trimmed.replace(/\/+$/, '');
    this.accessKey = String(accessKey).trim();
    this.merchantPrivateKey = decodeKey(
      merchantPrivateKeyBase64, [32, 64], 'merchant Ed25519 private key',
    );
    this.bodyKeyId = String(platformBodyKeyId).trim();
    this.bodyPublicKey = decodeKey(
      platformBodyPublicKeyBase64, [p.X25519_PUBLIC_KEY_SIZE], 'platform X25519 public key',
    );
    this.webhookKeys = new Map(webhookEntries.map(([keyId, value]) => {
      const id = String(keyId ?? '').trim();
      if (!id) throw new ConfigError('sdk: platform webhook key id must not be empty');
      return [id, decodeKey(
        value, [p.ED25519_PUBLIC_KEY_SIZE], 'platform webhook Ed25519 public key',
      )];
    }));

    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent || DEFAULT_USER_AGENT;
    this.acceptLanguage = acceptLanguage || DEFAULT_ACCEPT_LANGUAGE;
    this.maxResponseBytes = maxResponseBytes;
    this.fetchImpl = fetchImpl;
    this.now = now ?? (() => Math.floor(Date.now() / 1000));
  }

  async createPayment(req, { idempotencyKey } = {}) {
    validateCreateCommon(req);
    validatePaymentMethod(req?.currency, req?.paymentMethod);
    return this.#write('/api/v1/payments', req, idempotencyKey);
  }

  async createPayout(req, { idempotencyKey } = {}) {
    validateCreateCommon(req);
    validatePayoutMethod(req?.currency, req?.payoutMethod);
    return this.#write('/api/v1/payouts', req, idempotencyKey);
  }

  queryPaymentByOrderNo(orderNo) {
    return this.#read('/api/v1/payments', { orderNo });
  }

  queryPaymentByMerchantOrderNo(merchantOrderNo) {
    return this.#read('/api/v1/payments', { merchantOrderNo });
  }

  queryPayoutByOrderNo(orderNo) {
    return this.#read('/api/v1/payouts', { orderNo });
  }

  queryPayoutByMerchantOrderNo(merchantOrderNo) {
    return this.#read('/api/v1/payouts', { merchantOrderNo });
  }

  getPayoutReceipt(orderNo) {
    const value = validatePathOrderNo(orderNo);
    return this.#read(`/api/v1/payouts/${encodeURIComponent(value)}/receipt`, null);
  }

  getBalance(currency) {
    return this.#read('/api/v1/balances', { currency });
  }

  getUsdRate(currency, payMethod) {
    return this.#read('/api/v1/usd-rates', { currency, payMethod });
  }

  /** Public hosted-checkout query: unsigned, unencrypted. */
  getPaymentCheckout(orderNo) {
    const url = `${this.baseUrl}/api/v1/payment/checkout?${new URLSearchParams({ orderNo })}`;
    return this.#send(url, { method: 'GET', headers: {}, body: null });
  }

  /**
   * Reports the upstream transaction reference (UTR) the payer entered on the hosted
   * checkout so the platform can match the transfer to the order. Unsigned and
   * unencrypted, like checkout.
   *
   * Resolving does not mean accepted: the platform answers HTTP 200 / code 200 on
   * rejection too, and the outcome is in the resolved object's status field
   * (1 accepted, 0 rejected with message giving the reason).
   */
  submitPaymentTradeNo(orderNo, tradeNo) {
    const no = String(orderNo ?? '').trim();
    const trade = String(tradeNo ?? '').trim();
    if (!no || !trade) throw new RequestError('sdk: invalid query parameter');
    return this.#publicPost('/api/v1/payment/submitTradeNo', { orderNo: no, tradeNo: trade });
  }

  /**
   * Completes payer details for an order created without them; only then does the
   * platform place the order with the channel. payMethod / extra may be omitted when
   * the order already carries them. Unsigned and unencrypted; data.status has the
   * same meaning as in submitPaymentTradeNo.
   */
  addPaymentExtraInfo(orderNo, payMethod, extra) {
    const no = String(orderNo ?? '').trim();
    if (!no) throw new RequestError('sdk: invalid query parameter');
    const body = { orderNo: no };
    const method = String(payMethod ?? '').trim();
    if (method) body.payMethod = method;
    if (extra && Object.keys(extra).length) body.extra = extra;
    return this.#publicPost('/api/v1/payment/addExtraInfo', body);
  }

  /**
   * Sealing and signing happen before the request is sent, so a protocol failure
   * there is a request error rather than an unknown outcome.
   */
  async #build(builder, args) {
    try {
      return await builder(args);
    } catch (err) {
      if (err instanceof p.ProtocolError) {
        throw new RequestError(`sdk: build signed request: ${err.message}`);
      }
      throw err;
    }
  }

  #publicPost(path, body) {
    return this.#send(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: encodeBody(body),
    });
  }

  /**
   * Verifies a platform webhook (shape, Content-Digest, event id, time window and
   * Ed25519 signature) and returns the parsed body.
   */
  async verifyWebhook({ method, path, headers, body, rawQuery = '' }) {
    if (String(method ?? '').toUpperCase() !== 'POST') {
      throw new WebhookError('sdk: webhook must be POST');
    }
    const lowered = Object.fromEntries(
      Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    if (String(lowered['content-type'] ?? '').trim() !== 'application/json') {
      throw new WebhookError('sdk: webhook Content-Type must be application/json');
    }
    const raw = Buffer.from(body ?? []);
    if (!raw.length || raw.length > p.MAX_WIRE_BODY_BYTES) {
      throw new WebhookError('sdk: invalid webhook body size');
    }
    if (!p.verifyContentDigest(raw, lowered[p.HEADER_CONTENT_DIGEST.toLowerCase()])) {
      throw new WebhookError('sdk: webhook Content-Digest mismatch');
    }

    const eventId = String(lowered[p.HEADER_WEBHOOK_EVENT_ID.toLowerCase()] ?? '').trim();
    p.validateWebhookEventId(eventId);
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new WebhookError('sdk: invalid webhook body');
    }
    if (parsed?.eventId !== eventId) throw new WebhookError('sdk: webhook event id mismatch');

    const params = p.parsePlatformSignatureInput(
      lowered[p.HEADER_SIGNATURE_INPUT.toLowerCase()] ?? '',
    );
    p.validateSignatureParams(params, this.now());
    const publicKey = this.webhookKeys.get(params.keyId);
    if (!publicKey) throw new WebhookError('sdk: webhook platform key not found');

    const signature = p.parseSignature(
      lowered[p.HEADER_SIGNATURE.toLowerCase()] ?? '', p.SIGNATURE_LABEL_PLATFORM,
    );
    const base = p.signatureBase(params, { method: 'POST', path, rawQuery, headers });
    await p.verifyEd25519(publicKey, base, signature);
    return parsed;
  }

  async parsePaymentWebhook(args) {
    return requireWebhookFields(await this.verifyWebhook(args), WEBHOOK_ORDER_TYPE_PAYMENT);
  }

  async parsePayoutWebhook(args) {
    return requireWebhookFields(await this.verifyWebhook(args), WEBHOOK_ORDER_TYPE_PAYOUT);
  }

  async #write(path, body, idempotencyKey) {
    const key = String(idempotencyKey ?? p.newNonce()).trim();
    const url = this.baseUrl + path;
    // Rejecting a malformed key is a pre-send failure like any other build
    // failure, so it runs inside #build and surfaces as RequestError.
    const built = await this.#build((args) => {
      p.validateIdempotencyKey(key);
      return buildWrite(args);
    }, {
      endpointUrl: url,
      accessKey: this.accessKey,
      idempotencyKey: key,
      bodyKeyId: this.bodyKeyId,
      bodyPublicKey: this.bodyPublicKey,
      merchantPrivateKey: this.merchantPrivateKey,
      body: encodeBody(body),
      nonce: p.newNonce(),
      now: this.now(),
    });
    return this.#send(url, built);
  }

  async #read(path, query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (!String(value ?? '').trim()) {
        throw new RequestError(`sdk: invalid query parameter: ${key}`);
      }
      params.set(key, value);
    }
    // URLSearchParams.size landed in Node 18.16; on an earlier 18.x it is
    // undefined, which silently dropped the whole query string.
    const queryString = params.toString();
    const url = this.baseUrl + path + (queryString ? `?${queryString}` : '');
    const built = await this.#build(buildRead, {
      endpointUrl: url,
      accessKey: this.accessKey,
      merchantPrivateKey: this.merchantPrivateKey,
      nonce: p.newNonce(),
      now: this.now(),
    });
    return this.#send(url, built);
  }

  async #send(url, built) {
    const headers = {
      ...built.headers,
      Accept: 'application/json',
      'Accept-Language': this.acceptLanguage,
      'User-Agent': this.userAgent,
    };
    let response;
    let raw;
    try {
      response = await this.fetchImpl(url, {
        method: built.method,
        headers,
        body: built.body ?? undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      raw = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      // Connect failure, timeout or a broken read: the request may have reached the platform.
      throw new TransportError(`sdk: send request: ${err.message}`);
    }
    return this.#decode(response.status, raw);
  }

  #decode(httpStatus, raw) {
    if (raw.length > this.maxResponseBytes) {
      throw new ResponseTooLargeError('sdk: response body exceeds maxResponseBytes');
    }
    let envelope;
    try {
      envelope = JSON.parse(raw.toString('utf8'));
      if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw new Error('envelope must be an object');
      }
    } catch {
      throw new ResponseError({ httpStatus, rawBody: raw });
    }
    // HTTP 200 with a non-200 envelope code is still a business failure.
    if (httpStatus !== 200 || envelope.code !== 200) {
      throw new APIError({
        httpStatus,
        code: Number.isInteger(envelope.code) ? envelope.code : 0,
        msg: String(envelope.msg ?? ''),
        message: typeof envelope.data?.message === 'string' ? envelope.data.message : '',
        traceId: String(envelope.traceId ?? ''),
        rawBody: raw,
      });
    }
    // A success envelope always carries the business object; handing back null
    // would let a caller record an order that has no orderNo as successful.
    if (envelope.data === null || typeof envelope.data !== 'object') {
      throw new ResponseError({ httpStatus, rawBody: raw });
    }
    return envelope.data;
  }
}

function requireWebhookFields(payload, orderType) {
  if (!payload?.eventId || payload.orderType !== orderType || !payload.orderNo
      || !payload.merchantOrderNo || !payload.status) {
    throw new WebhookError('sdk: invalid webhook body');
  }
  return payload;
}
