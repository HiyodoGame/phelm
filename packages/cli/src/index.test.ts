import { describe, expect, it } from 'vitest';
import { PHELM_CONTRACT_VERSION } from '@phelm/contract';
import { createProgram } from './index.js';

describe('phelm cli', () => {
  it('builds a program with the expected name', () => {
    const program = createProgram();
    expect(program.name()).toBe('phelm');
  });

  it('reports a non-empty version taken from the contract', () => {
    const program = createProgram();
    expect(program.version()).toBe(PHELM_CONTRACT_VERSION);
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('registers the placeholder board command', () => {
    const program = createProgram();
    const board = program.commands.find((command) => command.name() === 'board');
    expect(board).toBeDefined();
  });
});
