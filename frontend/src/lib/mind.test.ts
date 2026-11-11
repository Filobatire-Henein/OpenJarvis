import { describe, expect, it } from 'vitest';
import { parseSSE } from './mind';

describe('parseSSE', () => {
  it('extracts complete data frames and keeps the remainder', () => {
    const { payloads, rest } = parseSSE(
      'retry: 3000\n\nevent: thought\ndata: {"id":"t1"}\n\n: keep-alive\n\ndata: {"id"',
    );
    expect(payloads).toEqual(['{"id":"t1"}']);
    expect(rest).toBe('data: {"id"');
  });
});
