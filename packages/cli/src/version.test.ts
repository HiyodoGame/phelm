import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHELM_CLI_VERSION } from './version.js';

/**
 * PHELM_CLI_VERSION is hand-written next to the code but must never drift
 * from package.json — it is what `phelm --version` prints and what the
 * telemetry ping reports (a drift test beats a build-time codegen step for
 * something this small).
 */
describe('PHELM_CLI_VERSION', () => {
  it('matches the package.json version', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(PHELM_CLI_VERSION).toBe(pkg.version);
  });
});
