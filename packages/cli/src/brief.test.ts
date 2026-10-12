import { describe, expect, it } from 'vitest';
import {
  BriefingError,
  BriefingNotFoundError,
  fetchBriefingForDate,
  fetchLatestBriefing,
  printBriefing,
  utcToday,
} from './brief.js';
import type { Briefing } from './brief.js';

/**
 * Offline briefing tests: scripted fetch + pure output assertions. The
 * load-bearing one is printBriefing — stdout must be the server's contentMd
 * byte-for-byte, so the fixture carries a trailing newline that must survive.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONTENT_MD = [
  '# Daily briefing — 2026-10-12',
  '',
  '## Overview',
  '2 linkage gaps across 3 relations.',
  '',
  '## Impact chain',
  '- prj_a -> prj_b: gap g1 (high)',
  '',
].join('\n');

const SAMPLE: Briefing = {
  date: '2026-10-12',
  stats: {
    totalGaps: 2,
    relations: 3,
    maxSeverity: 'high',
    chains: 1,
    pendingDrafts: 1,
    draftRelations: 2,
  },
  contentMd: CONTENT_MD,
};

describe('fetchLatestBriefing / fetchBriefingForDate', () => {
  const base = { apiBaseUrl: 'http://localhost:3000/', token: 'tok' };

  it('fetches and validates the latest briefing', async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = (input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse(SAMPLE));
    };
    const briefing = await fetchLatestBriefing({ ...base, fetch: fetchFn });
    expect(briefing).toEqual(SAMPLE);
    expect(calls[0]).toBe('http://localhost:3000/briefings/latest');
  });

  it('fetches a briefing by date', async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = (input) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse(SAMPLE));
    };
    const briefing = await fetchBriefingForDate({ ...base, date: '2026-10-12', fetch: fetchFn });
    expect(briefing.date).toBe('2026-10-12');
    expect(calls[0]).toBe('http://localhost:3000/briefings/2026-10-12');
  });

  it('maps 401 / 503 / unreachable / other statuses to user-actionable errors', async () => {
    await expect(
      fetchLatestBriefing({ ...base, fetch: () => Promise.resolve(jsonResponse({}, 401)) }),
    ).rejects.toThrow(/rejected the API token/);
    await expect(
      fetchLatestBriefing({ ...base, fetch: () => Promise.resolve(jsonResponse({}, 503)) }),
    ).rejects.toThrow(/briefing endpoints disabled/);
    await expect(
      fetchLatestBriefing({ ...base, fetch: () => Promise.reject(new TypeError('down')) }),
    ).rejects.toThrow(/cannot reach/);
    await expect(
      fetchLatestBriefing({ ...base, fetch: () => Promise.resolve(jsonResponse({}, 500)) }),
    ).rejects.toThrow(/status 500/);
  });

  it('signals a missing latest briefing and a missing dated briefing distinctly', async () => {
    await expect(
      fetchLatestBriefing({ ...base, fetch: () => Promise.resolve(jsonResponse({}, 404)) }),
    ).rejects.toThrow(BriefingError);
    await expect(
      fetchLatestBriefing({ ...base, fetch: () => Promise.resolve(jsonResponse({}, 404)) }),
    ).rejects.toThrow(/no briefing available yet/);

    const error = await fetchBriefingForDate({
      ...base,
      date: '2026-10-12',
      fetch: () => Promise.resolve(jsonResponse({}, 404)),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BriefingNotFoundError);
    expect(error).toBeInstanceOf(BriefingError);
    if (error instanceof BriefingNotFoundError) {
      expect(error.date).toBe('2026-10-12');
      expect(error.message).toBe('no briefing for 2026-10-12');
    }
  });

  it('rejects unexpected payloads (zod) and non-JSON bodies', async () => {
    await expect(
      fetchLatestBriefing({ ...base, fetch: () => Promise.resolve(jsonResponse({ nope: 1 })) }),
    ).rejects.toThrow(/unexpected briefing payload/);
    await expect(
      fetchLatestBriefing({
        ...base,
        fetch: () => Promise.resolve(new Response('not json', { status: 200 })),
      }),
    ).rejects.toThrow(/unexpected briefing payload/);
  });
});

describe('utcToday', () => {
  it('returns the current UTC date as YYYY-MM-DD', () => {
    expect(utcToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(utcToday()).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('printBriefing', () => {
  it('writes the meta line to stderr and contentMd verbatim to stdout', () => {
    const out: string[] = [];
    const err: string[] = [];
    printBriefing(SAMPLE, {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(err).toEqual(['briefing for 2026-10-12']);
    // Verbatim: no prefix, no added or stripped trailing newline.
    expect(out).toEqual([CONTENT_MD]);
    expect(out[0]?.endsWith('\n')).toBe(true);
  });

  it('keeps stdout free of any other text', () => {
    const out: string[] = [];
    printBriefing(SAMPLE, { out: (text) => out.push(text), err: () => undefined });
    expect(out.join('')).toBe(SAMPLE.contentMd);
  });
});
