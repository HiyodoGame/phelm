import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER_INFO } from './info.js';

/**
 * MCP_SERVER_INFO.version is hand-written next to the code but must never
 * drift from package.json — it is what the server reports at initialize.
 */
describe('MCP_SERVER_INFO.version', () => {
  it('matches the package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(MCP_SERVER_INFO.version).toBe(pkg.version);
  });
});
