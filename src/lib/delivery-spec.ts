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
  | 'unknown_kind'
  | 'missing_channel_session_id'
  | 'invalid_thread_id'
  | 'invalid_ws_url'
  | 'invalid_auth_token_ref';

export type ValidateDeliveryResult =
  | { ok: DeliverySpec }
  | { error: 'invalid_delivery'; reason: DeliveryValidationReason };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readTrimmedString(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : '';
}

export function validateDeliveryForWrite(input: unknown): ValidateDeliveryResult {
  if (typeof input !== 'object' || input === null) {
    return { error: 'invalid_delivery', reason: 'unknown_kind' };
  }
  const record = input as Record<string, unknown>;
  const kind = record.kind;
  if (kind === 'none') {
    return { ok: { kind: 'none' } };
  }
  if (kind === 'claude-channel') {
    const csid = readTrimmedString(record, 'channel_session_id');
    if (csid === undefined || csid.length === 0) {
      return { error: 'invalid_delivery', reason: 'missing_channel_session_id' };
    }
    return { ok: { kind: 'claude-channel', channel_session_id: csid } };
  }
  if (kind === 'codex-appserver') {
    const threadId = readTrimmedString(record, 'thread_id');
    if (threadId === undefined || threadId.length === 0 || !UUID_RE.test(threadId)) {
      return { error: 'invalid_delivery', reason: 'invalid_thread_id' };
    }

    const wsUrl = readTrimmedString(record, 'ws_url');
    if (wsUrl === undefined || wsUrl.length === 0) {
      return { error: 'invalid_delivery', reason: 'invalid_ws_url' };
    }
    try {
      const parsed = new URL(wsUrl);
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        return { error: 'invalid_delivery', reason: 'invalid_ws_url' };
      }
    } catch {
      return { error: 'invalid_delivery', reason: 'invalid_ws_url' };
    }

    const authTokenRef = readTrimmedString(record, 'auth_token_ref');
    if (authTokenRef === '') {
      return { error: 'invalid_delivery', reason: 'invalid_auth_token_ref' };
    }

    return {
      ok: {
        kind: 'codex-appserver',
        thread_id: threadId,
        ws_url: wsUrl,
        ...(authTokenRef === undefined ? {} : { auth_token_ref: authTokenRef }),
      },
    };
  }
  return { error: 'invalid_delivery', reason: 'unknown_kind' };
}
