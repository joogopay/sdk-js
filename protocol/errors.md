# Response envelope and errors

## Envelope

Every endpoint returns the same envelope:

```json
{
  "code":    200,
  "msg":     "OK",
  "traceId": "abc123def456xyz",
  "data":    <business object, or {"message":"..."} error detail, or null>
}
```

| Field | Type | Meaning |
|---|---|---|
| `code` | int | `200` = business success; any other value is an error code (enum below), not the HTTP status |
| `msg` | string | machine-readable error identifier (`"OK"`, `"ORDER_NOT_FOUND"`, ...) |
| `traceId` | string | server-side trace id for troubleshooting |
| `data` | any | success: the business object; error: `{"message":"..."}` or `null` |

## Success rule

**Double check**: HTTP status == 200 **and** envelope `code` == 200. If either fails → `*APIError`.

The server always writes HTTP 200 + `code:200` on success and HTTP 4xx/5xx + `code:<error code>` on error. The SDK checks both to guard against future drift.

## Error msg enum

14 error msgs:

| Msg | Code | HTTP | Meaning |
|---|---:|---:|---|
| `UNAUTHORIZED` | 12100010 | 401 | authentication failed (bad signature, unknown access key, ...) |
| `INVALID_FIELD` | 12100007 | 400 | field validation failed |
| `UNSUPPORTED_CURRENCY` | 12100008 | 400 | unsupported currency |
| `UNSUPPORTED_METHOD` | 12100009 | 400 | unsupported pay-in / pay-out method |
| `INSUFFICIENT_BALANCE` | 12100011 | 402 | insufficient balance |
| `METHOD_NOT_ENABLED` | 12100012 | 403 | method not enabled |
| `ORDER_NOT_FOUND` | 12100013 | 404 | order does not exist |
| `IDEMPOTENCY_CONFLICT` | 12100014 | 409 | `merchantOrderNo` is taken but the platform could not return its order; query that number, do not allocate a new one |
| `RATE_LIMITED` | 12100015 | 429 | rate limited |
| `SERVICE_UNAVAILABLE` | 12100017 | 503 | service unavailable |
| `INTERNAL_ERROR` | 12100016 | 500 | internal error |
| `ORDER_REJECTED` | 12100018 | 403 | order rejected (risk control, business rules) |
| `CHANNEL_ERROR` | 12100019 | 422 | upstream channel error (channel rejection, parameter rejection, network/timeout, ...) |
| `CHANNEL_BUSY` | 12100020 | 503 | the channel is rate limiting; the order was not created |

`OK` is the success msg, not an error.

### Handling `CHANNEL_BUSY`

The gateway refuses before the order is created, so the same `merchantOrderNo`
can be sent again after a short back-off. This is the one channel-side error
where no query is needed first.

### Handling `CHANNEL_ERROR`

The order may already exist. **Do not retry with a new `merchantOrderNo`**: query the original number with `GET /api/v1/payments` (pay-in) or `GET /api/v1/payouts` (pay-out), or wait for the `FAILED` webhook. Only after the query returns `ORDER_NOT_FOUND` may the same number be used to create the order again.

## Non-envelope responses

A non-JSON body (an HTML error page or a plain-text 502 from a gateway or CDN) → the SDK returns `*ResponseError` (with HTTPStatus + RawBody), distinct from `*APIError`. Merchant-side handling:

```go
var apiErr *joogopay.APIError
var respErr *joogopay.ResponseError
switch {
case errors.As(err, &apiErr):
    // business error (envelope parsed)
case errors.As(err, &respErr):
    // infrastructure error (gateway/CDN returned a non-envelope body)
default:
    // transport error (network, timeout, context cancel)
}
```
