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
