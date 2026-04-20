import { describe, it, expectTypeOf, expect } from 'vitest';
import type { DeliverySpec } from '../src/lib/delivery-spec.js';
import * as deliverySpecModule from '../src/lib/delivery-spec.js';

describe('DeliverySpec discriminated union shape', () => {
  it('module loads from src/lib/delivery-spec', () => {
    expect(deliverySpecModule).toBeDefined();
  });

  it('accepts kind none with no payload fields', () => {
    const spec: DeliverySpec = { kind: 'none' };
    expect(spec.kind).toBe('none');
    expectTypeOf(spec).toMatchTypeOf<{ kind: 'none' }>();
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
    const spec: DeliverySpec = { kind: 'claude-channel', channel_session_id: 'csid-xyz' };
    if (spec.kind === 'none') {
      expect(false).toBe(true);
    } else if (spec.kind === 'claude-channel') {
      expect(spec.channel_session_id).toBe('csid-xyz');
    } else {
      expect(spec.kind).toBe('codex-appserver');
    }
  });
});
