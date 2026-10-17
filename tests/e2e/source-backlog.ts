/** Maximum token-bucket excess using emission timestamps (ms), independent of IPC arrival order. */
export function sourceBacklog(timestamps: readonly number[], ratePerSecond: number): number {
  const times = [...timestamps].sort((a, b) => a - b);
  let previous = times[0] ?? 0;
  let excess = 0;
  let maximum = 0;
  for (const time of times) {
    excess = 1 + Math.max(0, excess - (ratePerSecond * (time - previous)) / 1000);
    maximum = Math.max(maximum, excess);
    previous = time;
  }
  return Math.round(maximum);
}
