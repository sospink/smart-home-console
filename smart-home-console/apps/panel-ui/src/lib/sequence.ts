export type SequenceDecision = "apply" | "ignore" | "recover";

export function sequenceDecision(current: number | undefined, received: number, snapshotEvent = false): SequenceDecision {
  if (snapshotEvent || current === undefined) return "apply";
  if (received <= current) return "ignore";
  if (received > current + 1) return "recover";
  return "apply";
}
