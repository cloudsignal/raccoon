export function toPlatformId(channel: string, userId: string): string {
  return `${channel}:${userId}`;
}

export function fromPlatformId(platformId: string): { channel: string; userId: string } | null {
  const i = platformId.indexOf(':');
  if (i <= 0 || i === platformId.length - 1) return null;
  return { channel: platformId.slice(0, i), userId: platformId.slice(i + 1) };
}
