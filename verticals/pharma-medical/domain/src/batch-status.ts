/**
 * Batch status under Good Distribution Practice. Stock arrives in quarantine and can only be
 * supplied once a Responsible Person (RP) releases it. Rejected and recalled stock can never be supplied.
 *
 *   quarantine ──release──▶ released ──recall──▶ recalled
 *       │  └──reject──▶ rejected ──recall──▶ recalled
 *       └──recall──▶ recalled          released ──quarantine──▶ quarantine
 */

export const BATCH_STATUSES = ["quarantine", "released", "rejected", "recalled"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export type BatchAction = "release" | "reject" | "quarantine" | "recall";

const TRANSITIONS: Record<BatchAction, { from: BatchStatus[]; to: BatchStatus; needsReason: boolean; past: string }> = {
  release: { from: ["quarantine"], to: "released", needsReason: false, past: "released" },
  reject: { from: ["quarantine"], to: "rejected", needsReason: true, past: "rejected" },
  quarantine: { from: ["released"], to: "quarantine", needsReason: true, past: "returned to quarantine" },
  recall: { from: ["quarantine", "released", "rejected"], to: "recalled", needsReason: true, past: "recalled" },
};

export class BatchTransitionError extends Error {}

export interface TransitionInput {
  from: BatchStatus;
  action: BatchAction;
  /** The acting user is a named Responsible Person for this licence. */
  actorIsRp: boolean;
  reason?: string | null;
  expiry: string;
  onDate: string;
}

/** Validate a status change and return the new status. Every quality decision needs an RP. */
export function transitionBatch(input: TransitionInput): BatchStatus {
  const t = TRANSITIONS[input.action];
  if (!input.actorIsRp) throw new BatchTransitionError("Only a Responsible Person can change a batch's status");
  if (!t.from.includes(input.from)) throw new BatchTransitionError(`A ${input.from} batch cannot be ${t.past}`);
  if (t.needsReason && !input.reason?.trim()) throw new BatchTransitionError(`Give a reason when a batch is ${t.past}`);
  if (input.action === "release" && input.expiry < input.onDate) {
    throw new BatchTransitionError("An expired batch cannot be released; reject it instead");
  }
  return t.to;
}

export function allowedActions(from: BatchStatus): BatchAction[] {
  return (Object.keys(TRANSITIONS) as BatchAction[]).filter((a) => TRANSITIONS[a].from.includes(from));
}
