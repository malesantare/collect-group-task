export function classifyChange(previous: bigint | null, current: bigint) {
  if (current < 0n || (previous !== null && previous < 0n)) throw new Error('Balance cannot be negative.');
  if (previous === null) return { kind: 'BASELINE' as const, delta: null };
  if (previous === current) return null;
  const delta = current - previous;
  return { kind: delta > 0n ? 'INFLOW' as const : 'DECREASE' as const, delta };
}
