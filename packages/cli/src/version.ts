/**
 * The CLI's own version, reported by `phelm --version` and as the telemetry
 * ping's `version` field. The README's Privacy section promises "the CLI
 * version" — NOT the contract version (@phelm/contract moves on its own
 * release cadence and previously leaked into both surfaces, review P1 fix).
 * Kept in lockstep with package.json by version.test.ts.
 */
export const PHELM_CLI_VERSION = '0.0.1';
