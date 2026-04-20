export type DeliveryNone = {
  kind: 'none';
};

export type DeliveryClaudeChannel = {
  kind: 'claude-channel';
  channel_session_id: string;
};

export type DeliveryCodexAppserver = {
  kind: 'codex-appserver';
  thread_id: string;
  ws_url: string;
  auth_token_ref?: string;
};

export type DeliverySpec =
  | DeliveryNone
  | DeliveryClaudeChannel
  | DeliveryCodexAppserver;

export type DeliveryKind = DeliverySpec['kind'];

export const DELIVERY_KINDS: readonly DeliveryKind[] = [
  'none',
  'claude-channel',
  'codex-appserver',
] as const;

export type DeliveryRow = {
  delivery_kind: string;
  delivery_payload: string | null;
};

export function parseDeliveryRow(row: DeliveryRow): DeliverySpec {
  const kind = row.delivery_kind;
  if (kind === 'none') {
    return { kind: 'none' };
  }
  let payload: unknown;
  try {
    payload = row.delivery_payload == null ? {} : JSON.parse(row.delivery_payload);
  } catch {
    throw new Error('corrupt_delivery_payload');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('corrupt_delivery_payload');
  }
  return { kind, ...(payload as Record<string, unknown>) } as DeliverySpec;
}

export function serializeDelivery(spec: DeliverySpec): DeliveryRow {
  if (spec.kind === 'none') {
    return { delivery_kind: 'none', delivery_payload: null };
  }
  const { kind, ...rest } = spec;
  return {
    delivery_kind: kind,
    delivery_payload: JSON.stringify(rest),
  };
}

export type DeliveryValidationReason =
  | 'kind_not_yet_supported'
  | 'unknown_kind'
  | 'missing_channel_session_id';

export type ValidateDeliveryResult =
  | { ok: DeliverySpec }
  | { error: 'invalid_delivery'; reason: DeliveryValidationReason };

export function validateDeliveryForWrite(input: unknown): ValidateDeliveryResult {
  if (typeof input !== 'object' || input === null) {
    return { error: 'invalid_delivery', reason: 'unknown_kind' };
  }
  const kind = (input as { kind?: unknown }).kind;
  if (kind === 'none') {
    return { ok: { kind: 'none' } };
  }
  if (kind === 'claude-channel') {
    const csid = (input as { channel_session_id?: unknown }).channel_session_id;
    if (typeof csid !== 'string' || csid.length === 0) {
      return { error: 'invalid_delivery', reason: 'missing_channel_session_id' };
    }
    return { ok: { kind: 'claude-channel', channel_session_id: csid } };
  }
  if (kind === 'codex-appserver') {
    return { error: 'invalid_delivery', reason: 'kind_not_yet_supported' };
  }
  return { error: 'invalid_delivery', reason: 'unknown_kind' };
}
