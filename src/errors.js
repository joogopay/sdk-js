// Gateway envelope msg values. Open set: unknown values are opaque strings.
export const MSG = Object.freeze({
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_FIELD: 'INVALID_FIELD',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  METHOD_NOT_ENABLED: 'METHOD_NOT_ENABLED',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ORDER_REJECTED: 'ORDER_REJECTED',
  CHANNEL_ERROR: 'CHANNEL_ERROR',
  CHANNEL_BUSY: 'CHANNEL_BUSY',
});

export class SDKError extends Error {
  constructor(message) { super(message); this.name = new.target.name; }
}

/** A Client option is missing or invalid. */
export class ConfigError extends SDKError {}
/** The request was rejected before it was sent: local validation or a bad parameter. */
export class RequestError extends SDKError {}
/**
 * No response was obtained after the request left the process (connection failure, timeout,
 * interrupted read). The outcome is unknown: query the order before retrying.
 */
export class TransportError extends SDKError {}
/** Webhook verification or parsing failed. */
export class WebhookError extends SDKError {}
/** The response body exceeds maxResponseBytes. */
export class ResponseTooLargeError extends SDKError {}

/** The gateway returned a well-formed envelope with a business failure. */
export class APIError extends SDKError {
  constructor({ httpStatus, code, msg = '', message = '', traceId = '', rawBody = null }) {
    super(`sdk: http=${httpStatus} code=${code} msg=${msg} traceId=${traceId}`
      + (message ? ` message=${message}` : ''));
    Object.assign(this, { httpStatus, code, msg, apiMessage: message, traceId, rawBody });
  }
}

/** The response is not a valid envelope JSON (HTML error page from the gateway or CDN, plain-text 502, ...). */
export class ResponseError extends SDKError {
  constructor({ httpStatus, rawBody = null }) {
    super(`sdk: http=${httpStatus} response is not a valid envelope JSON`);
    Object.assign(this, { httpStatus, rawBody });
  }
}
