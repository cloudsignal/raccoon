import { z } from 'zod';
import { kvDel, kvGet, kvSet } from './idb.js';

const sessionSchema = z.object({
  url: z.string().min(1),
  sessionToken: z.string().min(1),
  userId: z.string().min(1),
  instance: z.string().min(1),
  channels: z.array(z.string()),
  vapidPublicKey: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

const KEY = 'session';

export async function loadSession(): Promise<Session | null> {
  const raw = await kvGet<unknown>(KEY);
  const parsed = sessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function saveSession(s: Session): Promise<void> {
  await kvSet(KEY, sessionSchema.parse(s));
}

export async function clearSession(): Promise<void> {
  await kvDel(KEY);
}
