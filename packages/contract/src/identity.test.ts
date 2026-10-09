import { describe, expect, it } from 'vitest';
import { DecisionLogSchema, UserSchema } from './identity.js';

describe('UserSchema', () => {
  it('parses a valid user', () => {
    const user = UserSchema.parse({
      id: 'user-1',
      githubLogin: 'hiyodo',
      settings: { notificationLevel: 'all' },
    });
    expect(user.settings.briefingTime).toBe('08:30');
    expect(user.settings.notificationLevel).toBe('all');
  });

  it('accepts an explicit briefing time and a linked Huawei uid', () => {
    const user = UserSchema.parse({
      id: 'user-1',
      githubLogin: 'hiyodo',
      huaweiUid: 'uid-123',
      settings: { briefingTime: '21:45', notificationLevel: 'important_only' },
    });
    expect(user.huaweiUid).toBe('uid-123');
    expect(user.settings.briefingTime).toBe('21:45');
  });

  it('rejects invalid briefing times and notification levels', () => {
    const base = { id: 'user-1', githubLogin: 'hiyodo' };
    expect(
      UserSchema.safeParse({
        ...base,
        settings: { briefingTime: '8:30', notificationLevel: 'all' },
      }).success,
    ).toBe(false);
    expect(
      UserSchema.safeParse({
        ...base,
        settings: { briefingTime: '24:00', notificationLevel: 'all' },
      }).success,
    ).toBe(false);
    expect(
      UserSchema.safeParse({
        ...base,
        settings: { briefingTime: '08:30', notificationLevel: 'none' },
      }).success,
    ).toBe(false);
  });
});

describe('DecisionLogSchema', () => {
  it('parses a valid entry for both actors', () => {
    for (const actor of ['user', 'agent'] as const) {
      const entry = DecisionLogSchema.parse({
        id: 'dl-1',
        actor,
        actorRef: actor === 'user' ? 'user-1' : 'zcode',
        action: 'suggestion.dismissed',
        ref: 'sug-9',
        ts: '2026-10-09T08:31:00Z',
      });
      expect(entry.actor).toBe(actor);
    }
  });

  it('rejects unknown actors and malformed timestamps', () => {
    const base = {
      id: 'dl-1',
      actorRef: 'user-1',
      action: 'a',
      ref: 'r',
      ts: '2026-10-09T08:31:00Z',
    };
    expect(DecisionLogSchema.safeParse({ ...base, actor: 'system' }).success).toBe(false);
    expect(DecisionLogSchema.safeParse({ ...base, actor: 'user', ts: '2026-10-09' }).success).toBe(
      false,
    );
  });
});
