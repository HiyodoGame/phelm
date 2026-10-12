import { describe, expect, it } from 'vitest';
import { parseTransportArgs, UsageError } from './transport.js';

describe('parseTransportArgs', () => {
  it('defaults to stdio with no arguments', () => {
    expect(parseTransportArgs([])).toEqual({ mode: 'stdio' });
  });

  it('accepts --http <port> and --http=<port>', () => {
    expect(parseTransportArgs(['--http', '3000'])).toEqual({ mode: 'http', port: 3000 });
    expect(parseTransportArgs(['--http=8080'])).toEqual({ mode: 'http', port: 8080 });
  });

  it('rejects a missing, non-integer or out-of-range port', () => {
    expect(() => parseTransportArgs(['--http'])).toThrow(UsageError);
    expect(() => parseTransportArgs(['--http', ''])).toThrow(UsageError);
    expect(() => parseTransportArgs(['--http', 'zero'])).toThrow(/between 1 and 65535/);
    expect(() => parseTransportArgs(['--http', '0'])).toThrow(UsageError);
    expect(() => parseTransportArgs(['--http', '65536'])).toThrow(UsageError);
  });

  it('rejects trailing junk after --http <port> instead of swallowing it', () => {
    expect(() => parseTransportArgs(['--http', '3000', 'junk'])).toThrow(/unknown argument "junk"/);
    expect(() => parseTransportArgs(['--http=3000', '--other'])).toThrow(UsageError);
    expect(() => parseTransportArgs(['--http', '3000', '--http', '4000'])).toThrow(
      /more than once/,
    );
  });

  it('rejects unknown arguments', () => {
    expect(() => parseTransportArgs(['--serve'])).toThrow(/unknown argument "--serve"/);
  });

  it('treats --help as a usage request (message carries the usage text)', () => {
    expect(() => parseTransportArgs(['--help'])).toThrow(/phelm-mcp - MCP server/);
    expect(() => parseTransportArgs(['-h'])).toThrow(UsageError);
  });
});
