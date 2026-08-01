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
 *  the first. Returns the number of envelopes sent. */
export async function deliverFilesAsAttachments(
  deps: { media: Pick<MediaStore, 'save'>; send: (userId: string, env: AnyEnvelope) => Promise<boolean> },
  channel: string,
  userId: string,
  files: OutboundFile[],
  text: string,
): Promise<number> {
  const saved: Attachment[] = [];
  for (const f of files) {
    const res = await deps.media.save(Readable.from(f.data), {
      mime: mimeFor(f.filename),
      name: f.filename,
      uploadedBy: `agent:${channel}`,
      declaredLength: f.data.length,
    });
    if (res.ok) saved.push(res.attachment);
    else console.error(`raccoon: outbound media save failed for ${f.filename}: ${res.error}`);
  }
  if (saved.length === 0 && text.length === 0) return 0;

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
        text: i === 0 ? text : '',
        ...(chunk.length > 0 ? { attachments: chunk } : {}),
      },
    });
    await deps.send(userId, env);
    sentCount += 1;
  }
  return sentCount;
}
