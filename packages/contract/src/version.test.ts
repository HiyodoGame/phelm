import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHELM_CONTRACT_VERSION } from './index.js';

/**
 * PHELM_CONTRACT_VERSION is the single version word every surface quotes
 * (server compatibility checks, JSON-schema export); it must never drift
 * from package.json — a drift test beats a build-time codegen step here.
 */
describe('PHELM_CONTRACT_VERSION', () => {
  it('matches the package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(PHELM_CONTRACT_VERSION).toBe(pkg.version);
  });
});
