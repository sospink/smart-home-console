export function serverClockOffset(serverTime: string | undefined, localNow = Date.now()) {
  if (!serverTime) return 0;
  const parsed = Date.parse(serverTime);
  return Number.isFinite(parsed) ? parsed - localNow : 0;
}

export function authoritativeNow(localNow: number, offset: number) {
  return new Date(localNow + offset);
}
