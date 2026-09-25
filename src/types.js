export const STATUS_PENDING = 'PENDING';
export const STATUS_PROCESSING = 'PROCESSING';
export const STATUS_SUCCEEDED = 'SUCCEEDED';
export const STATUS_FAILED = 'FAILED';
export const STATUS_EXPIRED = 'EXPIRED';
export const STATUS_CANCELED = 'CANCELED';
export const STATUS_REFUNDED = 'REFUNDED';

/** Public order statuses. REFUNDED is payout-only; checkout progress is unchanged. */
export const EXTERNAL_STATUSES = Object.freeze([
  STATUS_PENDING, STATUS_PROCESSING, STATUS_SUCCEEDED,
  STATUS_FAILED, STATUS_EXPIRED, STATUS_CANCELED, STATUS_REFUNDED,
]);

export const WEBHOOK_ORDER_TYPE_PAYMENT = 'PAYMENT';
export const WEBHOOK_ORDER_TYPE_PAYOUT = 'PAYOUT';

/** Money fields in API payloads. Always decimal strings, never JSON numbers. */
export const MONEY_FIELDS = Object.freeze([
  'amount', 'paidAmount', 'refundAmount', 'minAmount', 'maxAmount', 'usdRate',
  'balance', 'lockBalance', 'paymentBalance', 'paymentLockBalance',
  'payoutBalance', 'payoutLockBalance',
]);
