// Keeps a per-IP Map bounded: once it holds more than `cap` entries, entries `isLive` calls dead
// are dropped, then (still over) the oldest ones. Used by the auth, pairing and audit counters.
export const MAX_TRACKED_IPS = 1024;

export function pruneMap(map, isLive, cap = MAX_TRACKED_IPS) {
  if (map.size <= cap) return;
  for (const [k, v] of map) if (!isLive(v)) map.delete(k);
  for (const k of map.keys()) {
    if (map.size <= cap) break;
    map.delete(k);
  }
}
