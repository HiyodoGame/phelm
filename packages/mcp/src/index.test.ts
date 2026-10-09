import { describe, expect, it } from 'vitest';
import { MCP_SERVER_INFO } from './index.js';

describe('MCP_SERVER_INFO', () => {
  it('exposes the server name', () => {
    expect(MCP_SERVER_INFO.name).toBe('phelm-mcp');
  });

  it('exposes a semver-like version', () => {
    expect(MCP_SERVER_INFO.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
