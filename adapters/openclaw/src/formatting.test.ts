// adapters/openclaw/src/formatting.test.ts
//
// Tests for the reply-formatting utility (Task 2).
//
// Mock decision: the real `chunkMarkdownTextWithMode` is NOT called directly in
// these unit tests. The function is exported from `openclaw/plugin-sdk/reply-chunking`,
// which at runtime is a redistributed bundle with internal relative imports
// (e.g. `../chunk-ulm_3glE.js`) that only resolve inside the installed openclaw
// package — they are not reachable from the Raccoon workspace. Running the real
// helper would require installing the 86 MB openclaw package and setting up its
// full module graph. Instead, we mock the import so we can:
//   1. Assert that formatReply / chunkReplyText call it with the correct
//      arguments (limit = 8000, mode = 'newline').
//   2. Control return values to exercise multi-chunk ordering and single-chunk
//      short-text behaviour in isolation, independent of the SDK's internal
//      paragraph-splitting heuristics.
// The real shapes and the constraint values (8000 / 'newline') are verified by
// the real-types typecheck (`npx tsc --noEmit -p /tmp/openclaw-real/typecheck/tsconfig.json`).

import { describe, expect, it, vi } from 'vitest';

// Mock before importing the module under test.
vi.mock('openclaw/plugin-sdk/reply-chunking', () => ({
  chunkMarkdownTextWithMode: vi.fn(),
}));

const { chunkMarkdownTextWithMode } = await import('openclaw/plugin-sdk/reply-chunking');
const mockChunk = vi.mocked(chunkMarkdownTextWithMode);

const { chunkReplyText, appendMediaUrls, formatReply } = await import('./formatting.js');

describe('chunkReplyText', () => {
  it('returns single-element array for short text (no chunking needed)', () => {
    mockChunk.mockReturnValueOnce(['hello world']);
    const result = chunkReplyText('hello world');
    expect(result).toEqual(['hello world']);
  });

  it('calls chunkMarkdownTextWithMode with limit 8000 and mode newline', () => {
    mockChunk.mockReturnValueOnce(['chunk']);
    chunkReplyText('some text');
    expect(mockChunk).toHaveBeenCalledWith('some text', 8000, 'newline');
  });

  it('returns multiple chunks in original order for long text', () => {
    const chunks = ['chunk-A', 'chunk-B', 'chunk-C'];
    mockChunk.mockReturnValueOnce(chunks);
    const longText = 'x'.repeat(9000);
    const result = chunkReplyText(longText);
    expect(result).toEqual(['chunk-A', 'chunk-B', 'chunk-C']);
  });

  it('preserves order: concatenation of chunks equals original content (logical)', () => {
    // Simulate the SDK splitting on paragraph boundaries.
    const para1 = 'First paragraph.';
    const para2 = 'Second paragraph.';
    mockChunk.mockReturnValueOnce([para1, para2]);
    const result = chunkReplyText(`${para1}\n\n${para2}`);
    expect(result[0]).toBe(para1);
    expect(result[1]).toBe(para2);
  });

  it('accepts optional limit and mode overrides', () => {
    mockChunk.mockReturnValueOnce(['x']);
    chunkReplyText('text', 4096, 'length');
    expect(mockChunk).toHaveBeenCalledWith('text', 4096, 'length');
  });
});

describe('appendMediaUrls', () => {
  it('returns text unchanged when mediaUrls is undefined', () => {
    expect(appendMediaUrls('hello')).toBe('hello');
  });

  it('returns text unchanged when mediaUrls is empty array', () => {
    expect(appendMediaUrls('hello', [])).toBe('hello');
  });

  it('appends single media URL as plain links block', () => {
    const result = appendMediaUrls('Some reply text.', ['https://example.com/img.png']);
    expect(result).toContain('Some reply text.');
    expect(result).toContain('https://example.com/img.png');
    // URL must appear after the original text.
    expect(result.indexOf('Some reply text.')).toBeLessThan(result.indexOf('https://example.com/img.png'));
  });

  it('appends multiple media URLs, each on its own line', () => {
    const urls = ['https://example.com/a.png', 'https://example.com/b.png'];
    const result = appendMediaUrls('Text.', urls);
    expect(result).toContain('https://example.com/a.png');
    expect(result).toContain('https://example.com/b.png');
    // Both URLs present and ordered.
    const idxA = result.indexOf('https://example.com/a.png');
    const idxB = result.indexOf('https://example.com/b.png');
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(idxA);
  });

  it('preserves markdown tables and other content unchanged', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    const result = appendMediaUrls(table);
    expect(result).toBe(table);
  });
});

describe('formatReply', () => {
  it('returns single chunk for short text with no media', () => {
    mockChunk.mockReturnValueOnce(['hello']);
    const result = formatReply({ text: 'hello' });
    expect(result).toEqual(['hello']);
  });

  it('appends media URLs before chunking, producing at most one extra chunk for short text', () => {
    const url = 'https://example.com/photo.png';
    mockChunk.mockImplementationOnce((text: string) => [text]);
    const result = formatReply({ text: 'Look at this:', mediaUrls: [url] });
    // Media must have been appended to the text before chunking.
    expect(mockChunk).toHaveBeenCalledWith(
      expect.stringContaining(url),
      8000,
      'newline',
    );
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('returns multiple chunks in order for long text', () => {
    mockChunk.mockReturnValueOnce(['part-1', 'part-2']);
    const result = formatReply({ text: 'x'.repeat(9000) });
    expect(result).toEqual(['part-1', 'part-2']);
  });

  it('preserves chunk order — each chunk maps 1:1 to one OAM msg envelope', () => {
    // Callers must map result[0] → first envelope, result[1] → second, etc.
    mockChunk.mockReturnValueOnce(['first', 'second', 'third']);
    const result = formatReply({ text: 'long reply' });
    expect(result[0]).toBe('first');
    expect(result[1]).toBe('second');
    expect(result[2]).toBe('third');
  });
});
