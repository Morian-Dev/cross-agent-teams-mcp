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
