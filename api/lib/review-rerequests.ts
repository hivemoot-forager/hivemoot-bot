/**
 * Re-request blocking reviewers after a PR is updated.
 *
 * When a trusted reviewer submits CHANGES_REQUESTED on a PR and the author
 * pushes a fix, GitHub does not automatically notify those reviewers. This
 * module re-requests them once CI passes on the new head, so they know the
 * author has addressed their feedback.
 *
 * Scope:
 * - Only acts on candidate PRs (hivemoot:candidate label).
 * - Only runs after CI passes (fail-closed: no request on pending or failed CI).
 * - Does not re-request reviewers who have already reviewed the current head.
 * - Requires opt-in via `governance.pr.reviewRequests.rerequestBlockers: true`.
 * - Requires `trustedReviewers` to be configured (empty list = no-op).
 *
 * No manual suppression in v1: if a reviewer was manually removed from a PR,
 * they may receive another request after the next push. This is a known
 * limitation documented in #406.
 */

import type { PRRef } from "./types.js";
import type { PROperations } from "./pr-operations.js";
import type { PRConfig } from "./repo-config.js";
import { isCIPassing } from "./merge-readiness.js";
import { LABELS, isLabelMatch } from "../config.js";

export interface RerequestBlockersParams {
  prs: PROperations;
  ref: PRRef;
  pr: {
    author: string;
    headSha: string;
    draft: boolean;
    state: string;
    labels: string[];
  };
  prConfig: PRConfig;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Re-request trusted reviewers who have CHANGES_REQUESTED on a prior head
 * after CI passes on the current head.
 *
 * Returns early (no-ops) when:
 * - `reviewRequests.rerequestBlockers` is not enabled
 * - `trustedReviewers` is empty
 * - PR is a draft
 * - PR is not a candidate (no hivemoot:candidate label)
 * - CI is not passing on the current head
 * - No blocking reviewers found (all have reviewed the current head or approved)
 */
export async function rerequestBlockingReviewers(
  params: RerequestBlockersParams
): Promise<void> {
  const { prs, ref, pr, prConfig, log } = params;

  // 1. Feature opt-in check
  if (!prConfig.reviewRequests?.rerequestBlockers) return;

  // 2. Trusted reviewers required
  const { trustedReviewers } = prConfig;
  if (trustedReviewers.length === 0) return;

  // 3. Draft check — don't ping reviewers on draft PRs
  if (pr.draft) return;

  // 4. PR must be open
  if (pr.state !== "open") return;

  // 5. Candidate check — only act on hivemoot:candidate PRs
  const isCandidate = pr.labels.some((label) =>
    isLabelMatch(label, LABELS.IMPLEMENTATION)
  );
  if (!isCandidate) return;

  // 6. CI gate — fail-closed: only re-request when CI is passing
  const ciPassing = await isCIPassing(prs, ref, pr.headSha);
  if (!ciPassing) return;

  // 7. Get reviewers who blocked a prior version (CHANGES_REQUESTED, not at current head)
  const blocking = await prs.getBlockingReviewers(ref, pr.headSha, trustedReviewers);
  if (blocking.size === 0) return;

  // 8. Exclude the PR author
  const author = pr.author.toLowerCase();
  for (const reviewer of blocking) {
    if (reviewer === author) blocking.delete(reviewer);
  }
  if (blocking.size === 0) return;

  // 9. Exclude reviewers who already have a pending request at this head
  const pending = await prs.getRequestedReviewers(ref);
  for (const reviewer of blocking) {
    if (pending.has(reviewer)) blocking.delete(reviewer);
  }
  if (blocking.size === 0) return;

  // 10. Request the eligible blockers (alphabetical for determinism)
  const toRequest = [...blocking].sort();
  log?.info(
    `[PR #${ref.prNumber}] Re-requesting ${toRequest.length} blocking reviewer(s) after push: ${toRequest.join(", ")}`
  );
  await prs.requestReviewers(ref, toRequest);
}
