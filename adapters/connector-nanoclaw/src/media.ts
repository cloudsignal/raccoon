import { Readable } from 'node:stream';
import { agentAddress, createEnvelope, userAddress, type AnyEnvelope, type Attachment } from '@raccoon/protocol';
import type { MediaStore } from '@raccoon/transport-ws';
import type { NanoClawAttachment, OutboundFile } from './nanoclaw-types.js';

const MEDIA_PATH_IN_TEXT = /(?<![\w:])(\/media\/[\w.-]+\/[^\s)\]"']+)/g;

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain',
};

function mimeFor(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

function typeOf(mime: string): string {
  const major = mime.split('/')[0];
  return major === 'image' || major === 'video' || major === 'audio' ? major : 'file';
}

export function toNanoClawAttachments(atts: Attachment[] | undefined, publicOrigin: string): NanoClawAttachment[] {
  return (atts ?? []).map((a) => ({ type: typeOf(a.mime), url: `${publicOrigin}${a.url}` }));
}

export function absolutizeMediaPaths(text: string, publicOrigin: string): string {
  return text.replace(MEDIA_PATH_IN_TEXT, `${publicOrigin}$1`);
}

/** Save NanoClaw outbox files into the hub's media store and deliver them as
 *  native msg attachments through the endpoint's outbound seam (which records
 *  history, references media, and applies push fallback — never raw
 *  hub.sendToUser). Protocol caps attachments at 4 per envelope; text rides
 *  the first. Save failures are NEVER silent to the user: a partial failure
 *  appends a "[N of M attachments could not be transferred]" line to the
 *  first envelope's text, and when every save fails with no text to ride on,
 *  one msg carrying only the failure notice is still sent. Returns the
 *  number of envelopes sent. */
export async function deliverFilesAsAttachments(
  deps: { media: Pick<MediaStore, 'save'>; send: (userId: string, env: AnyEnvelope) => Promise<boolean> },
  channel: string,
  userId: string,
  files: OutboundFile[],
  text: string,
): Promise<number> {
  const saved: Attachment[] = [];
  let failedCount = 0;
  for (const f of files) {
    const res = await deps.media.save(Readable.from(f.data), {
      mime: mimeFor(f.filename),
      name: f.filename,
      uploadedBy: `agent:${channel}`,
      declaredLength: f.data.length,
    });
    if (res.ok) saved.push(res.attachment);
    else {
      failedCount += 1;
      console.error(`raccoon: outbound media save failed for ${f.filename}: ${res.error}`);
    }
  }

  // Explicit partial-failure policy: the user must see that files went
  // missing, whether or not anything else survived to deliver.
  let firstText = text;
  if (failedCount > 0) {
    const notice = saved.length > 0
      ? `[${failedCount} of ${files.length} attachments could not be transferred]`
      : `[${failedCount} attachment(s) could not be transferred]`;
    firstText = firstText.length > 0 ? `${firstText}\n${notice}` : notice;
  }
  if (saved.length === 0 && firstText.length === 0) return 0; // nothing to say and nothing failed

  let sentCount = 0;
  const chunks: Attachment[][] = [];
  for (let i = 0; i < saved.length; i += 4) chunks.push(saved.slice(i, i + 4));
  if (chunks.length === 0) chunks.push([]);

  for (const [i, chunk] of chunks.entries()) {
    const env = createEnvelope('msg', {
      from: agentAddress(channel),
      to: userAddress(userId),
      channel,
      payload: {
        text: i === 0 ? firstText : '',
        ...(chunk.length > 0 ? { attachments: chunk } : {}),
      },
    });
    await deps.send(userId, env);
    sentCount += 1;
  }
  return sentCount;
}
