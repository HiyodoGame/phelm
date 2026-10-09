import { describe, expect, it } from 'vitest';
import { PHELM_CONTRACT_VERSION, TaskIdSchema } from './index.js';

describe('TaskIdSchema', () => {
  it('accepts well-formed task ids', () => {
    expect(TaskIdSchema.parse('T-0001')).toBe('T-0001');
    expect(TaskIdSchema.parse('T-1234')).toBe('T-1234');
  });

  it('rejects malformed task ids', () => {
    const invalid = ['', 'T-001', 'T-12345', 't-0001', 'T-00ab', 'T-0001 ', 'TASK-0001'];
    for (const value of invalid) {
      expect(TaskIdSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('PHELM_CONTRACT_VERSION', () => {
  it('is a semver-like string', () => {
    expect(PHELM_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
