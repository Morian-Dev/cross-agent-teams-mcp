import { describe, it, expectTypeOf, expect } from 'vitest';
import type { DeliverySpec } from '../src/lib/delivery-spec.js';
import * as deliverySpecModule from '../src/lib/delivery-spec.js';
import {
  parseDeliveryRow,
  serializeDelivery,
  validateDeliveryForWrite,
} from '../src/lib/delivery-spec.js';

describe('DeliverySpec discriminated union shape', () => {
  it('module loads from src/lib/delivery-spec', () => {
    expect(deliverySpecModule).toBeDefined();
  });

  it('accepts kind none with no payload fields', () => {
    const spec: DeliverySpec = { kind: 'none' };
    expect(spec.kind).toBe('none');
    expectTypeOf(spec).toExtend<{ kind: 'none' }>();
  });

  it('accepts kind claude-channel with channel_session_id', () => {
    const spec: DeliverySpec = {
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    };
    expect(spec.kind).toBe('claude-channel');
    if (spec.kind === 'claude-channel') {
      expectTypeOf(spec.channel_session_id).toEqualTypeOf<string>();
    }
  });

  it('accepts kind codex-appserver with thread_id, ws_url, optional auth_token_ref', () => {
    const specWithout: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'ws://localhost:1234',
    };
    const specWith: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'wss://example.com/app',
      auth_token_ref: 'env:CODEX_TOKEN',
    };
    expect(specWithout.kind).toBe('codex-appserver');
    expect(specWith.kind).toBe('codex-appserver');
    if (specWith.kind === 'codex-appserver') {
      expectTypeOf(specWith.thread_id).toEqualTypeOf<string>();
      expectTypeOf(specWith.ws_url).toEqualTypeOf<string>();
    }
  });

  it('narrows kind via discriminated field', () => {
    const describe = (spec: DeliverySpec): string => {
      if (spec.kind === 'none') return 'none';
      if (spec.kind === 'claude-channel') return spec.channel_session_id;
      return spec.thread_id;
    };
    expect(describe({ kind: 'none' })).toBe('none');
    expect(describe({ kind: 'claude-channel', channel_session_id: 'csid-xyz' })).toBe('csid-xyz');
    expect(
      describe({
        kind: 'codex-appserver',
        thread_id: '00000000-0000-0000-0000-000000000000',
        ws_url: 'ws://x',
      }),
    ).toBe('00000000-0000-0000-0000-000000000000');
  });
});

describe('parseDeliveryRow (Task 1.2)', () => {
  it('kind none row with null payload returns {kind: none}', () => {
    const row = { delivery_kind: 'none', delivery_payload: null };
    expect(parseDeliveryRow(row)).toEqual({ kind: 'none' });
  });

  it('kind claude-channel row reconstructs channel_session_id from JSON payload', () => {
    const row = {
      delivery_kind: 'claude-channel',
      delivery_payload: '{"channel_session_id":"csid-abc"}',
    };
    expect(parseDeliveryRow(row)).toEqual({
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    });
  });

  it('throws corrupt_delivery_payload when non-none payload fails to parse as JSON', () => {
    const row = { delivery_kind: 'claude-channel', delivery_payload: 'not-json' };
    expect(() => parseDeliveryRow(row)).toThrow('corrupt_delivery_payload');
  });
});

describe('serializeDelivery (Task 1.3)', () => {
  it('serializes {kind: none} to {delivery_kind: none, delivery_payload: null}', () => {
    const spec: DeliverySpec = { kind: 'none' };
    expect(serializeDelivery(spec)).toEqual({
      delivery_kind: 'none',
      delivery_payload: null,
    });
  });

  it('serializes claude-channel to JSON string payload with channel_session_id', () => {
    const spec: DeliverySpec = {
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    };
    expect(serializeDelivery(spec)).toEqual({
      delivery_kind: 'claude-channel',
      delivery_payload: '{"channel_session_id":"csid-abc"}',
    });
  });

  it('serializes codex-appserver to JSON payload with thread_id and ws_url', () => {
    const spec: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'ws://localhost:1234',
    };
    const result = serializeDelivery(spec);
    expect(result.delivery_kind).toBe('codex-appserver');
    expect(result.delivery_payload).not.toBeNull();
    const parsed = JSON.parse(result.delivery_payload as string);
    expect(parsed).toEqual({
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'ws://localhost:1234',
    });
  });

  it('serializes codex-appserver with optional auth_token_ref when present', () => {
    const spec: DeliverySpec = {
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'wss://example.com/app',
      auth_token_ref: 'env:CODEX_TOKEN',
    };
    const result = serializeDelivery(spec);
    const parsed = JSON.parse(result.delivery_payload as string);
    expect(parsed).toEqual({
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'wss://example.com/app',
      auth_token_ref: 'env:CODEX_TOKEN',
    });
  });

  it('roundtrips parseDeliveryRow(serializeDelivery(spec)) === spec for each kind', () => {
    const specs: DeliverySpec[] = [
      { kind: 'none' },
      { kind: 'claude-channel', channel_session_id: 'csid-xyz' },
      {
        kind: 'codex-appserver',
        thread_id: '00000000-0000-0000-0000-000000000000',
        ws_url: 'ws://x',
      },
      {
        kind: 'codex-appserver',
        thread_id: '11111111-1111-1111-1111-111111111111',
        ws_url: 'wss://y',
        auth_token_ref: 'env:FOO',
      },
    ];
    for (const spec of specs) {
      expect(parseDeliveryRow(serializeDelivery(spec))).toEqual(spec);
    }
  });
});

describe('validateDeliveryForWrite (Task 1.4)', () => {
  it('accepts {kind: none}', () => {
    const result = validateDeliveryForWrite({ kind: 'none' });
    expect(result).toEqual({ ok: { kind: 'none' } });
  });

  it('accepts {kind: claude-channel, channel_session_id: ...}', () => {
    const result = validateDeliveryForWrite({
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    });
    expect(result).toEqual({
      ok: { kind: 'claude-channel', channel_session_id: 'csid-abc' },
    });
  });

  it('rejects {kind: codex-appserver} with reason kind_not_yet_supported', () => {
    const result = validateDeliveryForWrite({
      kind: 'codex-appserver',
      thread_id: '00000000-0000-0000-0000-000000000000',
      ws_url: 'ws://localhost:1234',
    });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'kind_not_yet_supported',
    });
  });

  it('rejects unknown kind with reason unknown_kind', () => {
    const result = validateDeliveryForWrite({ kind: 'irc' });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'unknown_kind',
    });
  });

  it('rejects claude-channel missing channel_session_id with reason missing_channel_session_id', () => {
    const result = validateDeliveryForWrite({ kind: 'claude-channel' });
    expect(result).toEqual({
      error: 'invalid_delivery',
      reason: 'missing_channel_session_id',
    });
  });
});
