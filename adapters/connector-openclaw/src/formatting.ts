// adapters/openclaw/src/formatting.ts
//
// Pure, side-effect-free reply-formatting utility for the Raccoon → OpenClaw
// outbound path (Task 2).
//
// Responsibility: turn one agent reply (text + optional media) into an ordered
// string[] where EACH element maps to exactly one Raccoon `msg` envelope. The Task 4
// outbound adapter iterates the returned array and emits one envelope per entry,
// preserving order.
//
// ChunkMode note: the real SDK ChunkMode is "length" | "newline". There is no
// "paragraph" literal. The brief used 'paragraph' as a conceptual label for the
// behaviour; the SDK value that produces paragraph-boundary splitting is
// 'newline' — its JSDoc reads: "now it only breaks on paragraph boundaries
// (blank lines) unless the text exceeds the length limit." This file uses
// 'newline' to match the real type and achieve the desired semantics.
//
// Media note (v1): mediaUrls are appended as a plain links block before
// chunking. The Raccoon app renders markdown, so URLs are clickable inline.
// Native image envelopes (a dedicated protocol msg type with a media payload) are a
// future protocol extension; when that lands, the outbound adapter (Task 4)
// should pull media out of the last chunk and emit separate media envelopes
// rather than relying on this text-append path.

import { chunkMarkdownTextWithMode, type ChunkMode } from 'openclaw/plugin-sdk/reply-chunking';

/**
 * Raccoon text chunk limit (characters). Matches the Coordinator preview cap.
 * The wire protocol has no hard limit — this is a Raccoon-side policy choice.
 */
export const RACCOON_TEXT_LIMIT = 8000;

/**
 * Default chunk mode. 'newline' in the SDK means "prefer paragraph boundaries
 * (blank lines) as split points; fall back to length-based splitting only when
 * a single paragraph exceeds the limit."
 */
export const RACCOON_CHUNK_MODE: ChunkMode = 'newline';

/**
 * Append media URLs as a plain links block after the reply text.
 *
 * v1 implementation: concatenates URLs as plain text lines so the Raccoon app
 * can render them as markdown links. Native image envelopes (a future protocol
 * extension) are not yet supported; see module-level comment for migration path.
 *
 * @param text    The agent reply text.
 * @param mediaUrls Optional array of media URLs to append.
 * @returns The combined text. If `mediaUrls` is empty or undefined, returns
 *          `text` unchanged.
 */
export function appendMediaUrls(text: string, mediaUrls?: string[]): string {
  if (!mediaUrls || mediaUrls.length === 0) return text;
  const linkBlock = mediaUrls.join('\n');
  return `${text}\n\n${linkBlock}`;
}

/**
 * Split reply text into an ordered `string[]` using the OpenClaw SDK helper.
 * Short text (fits within `limit`) → single-element array.
 * Long text → multiple chunks in the order the SDK produces them.
 *
 * Callers MUST map each returned element to exactly one Raccoon `msg` envelope,
 * in the order returned. The Task 4 outbound adapter is responsible for that
 * mapping — this function is a pure utility.
 *
 * @param text  The text to chunk.
 * @param limit Character limit per chunk (default: RACCOON_TEXT_LIMIT = 8000).
 * @param mode  Chunking strategy (default: RACCOON_CHUNK_MODE = 'newline').
 */
export function chunkReplyText(
  text: string,
  limit: number = RACCOON_TEXT_LIMIT,
  mode: ChunkMode = RACCOON_CHUNK_MODE,
): string[] {
  return chunkMarkdownTextWithMode(text, limit, mode);
}

/**
 * Parameters for `formatReply`.
 */
export interface FormatReplyParams {
  /** The final agent reply text. */
  text: string;
  /**
   * Optional media URLs to append as a plain links block before chunking.
   * v1: text-append path only. Native protocol image envelopes are a future
   * extension (see module-level comment).
   */
  mediaUrls?: string[];
}

/**
 * Format one agent reply into an ordered `string[]` of Raccoon msg envelope bodies.
 *
 * Steps:
 *   1. Append any `mediaUrls` as a plain links block (v1).
 *   2. Chunk the combined text via `chunkMarkdownTextWithMode` (limit 8000,
 *      mode 'newline' → paragraph boundaries).
 *
 * The caller (Task 4 outbound adapter) maps result[i] → the (i+1)-th Raccoon msg
 * envelope, preserving order.
 *
 * @returns Ordered string[]. Guaranteed non-empty when text is non-empty.
 */
export function formatReply({ text, mediaUrls }: FormatReplyParams): string[] {
  const combined = appendMediaUrls(text, mediaUrls);
  return chunkReplyText(combined);
}
