import { z } from 'zod';
import raw from '../raccoon.config.json';

export type ChannelTone = 'navy' | 'amber' | 'violet' | 'rose' | 'emerald';

const tone = z.enum(['navy', 'amber', 'violet', 'rose', 'emerald']);

const configSchema = z.object({
  name: z.string().min(1),
  shortName: z.string().min(1),
  themeColor: z.string().min(1),
  wallpaper: z.string().min(1),
  outgoing: z.string().min(1),
  icons: z.object({
    icon192: z.string().min(1),
    icon512: z.string().min(1),
    appleTouch: z.string().min(1),
  }),
  channels: z.record(
    z.string(),
    z.object({ label: z.string().optional(), blurb: z.string().optional(), tone: tone.optional() }),
  ).default({}),
});

export type RaccoonConfig = z.infer<typeof configSchema>;
export const appConfig: RaccoonConfig = configSchema.parse(raw);

/** Avatar/label colors per tone — values match the v2 design frames. */
export const TONES: Record<ChannelTone, { avatar: string; label: string }> = {
  navy: { avatar: 'oklch(0.55 0.13 255)', label: 'oklch(0.55 0.13 255)' },
  amber: { avatar: 'oklch(0.72 0.14 70)', label: 'oklch(0.6 0.12 70)' },
  violet: { avatar: 'oklch(0.58 0.16 295)', label: 'oklch(0.58 0.16 295)' },
  rose: { avatar: 'oklch(0.65 0.16 15)', label: 'oklch(0.65 0.16 15)' },
  emerald: { avatar: 'oklch(0.62 0.13 165)', label: 'oklch(0.5 0.11 165)' },
};

const TONE_KEYS: ChannelTone[] = ['navy', 'amber', 'violet', 'rose', 'emerald'];

export interface ChannelMeta { label: string; blurb: string; tone: ChannelTone }

export function channelMeta(id: string): ChannelMeta {
  const override = appConfig.channels[id] ?? {};
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return {
    label: override.label ?? id.charAt(0).toUpperCase() + id.slice(1),
    blurb: override.blurb ?? 'Agent channel',
    tone: override.tone ?? TONE_KEYS[hash % TONE_KEYS.length]!,
  };
}
