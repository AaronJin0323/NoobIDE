/**
 * S11.1: the region two texts differ in — common prefix and suffix, never splitting a CRLF pair or a surrogate pair —
 * so a file changed on disk is reloaded without moving the cursor. Pure.
 */
export function changedRegion(current: string, next: string): { start: number; endCurrent: number; endNext: number } {
  const max = Math.min(current.length, next.length);
  let start = 0;
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  while (start > 0 && splitsPair(current, start)) start -= 1;
  let endCurrent = current.length;
  let endNext = next.length;
  while (endCurrent > start && endNext > start && current.charCodeAt(endCurrent - 1) === next.charCodeAt(endNext - 1)) {
    endCurrent -= 1;
    endNext -= 1;
  }
  while (endCurrent < current.length && splitsPair(current, endCurrent)) {
    endCurrent += 1;
    endNext += 1;
  }
  return { start, endCurrent, endNext };
}

/** True when offset `i` lies between `\r` and `\n` or inside a surrogate pair. */
function splitsPair(text: string, i: number): boolean {
  const before = text.charCodeAt(i - 1);
  const after = text.charCodeAt(i);
  return (
    (before === 13 && after === 10) || (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
  );
}
