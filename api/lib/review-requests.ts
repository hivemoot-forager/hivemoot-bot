/**
 * Trusted Reviewer Auto-Request
 *
 * When a candidate PR becomes reviewable (label added, draft→ready, CI passes),
 * requests up to `config.count` trusted reviewers who haven't yet reviewed at
 * the current head and don't already have a pending review request.
 *
 * Eligible set = trustedReviewers
 *   − PR author
 *   − currently_requested_reviewers    (pending request already exists)
 *   − already_reviewed_at_current_head (decisive review at headSha)
 *
 * When more than `count` reviewers are eligible, select alphabetically (first N).
 * This is deterministic and avoids the API cost of load-based selection.
 */

import type { PRRef } from "./types.js";
import type { PROperations } from "./pr-operations.js";
import type { ReviewRequestsConfig } from "./repo-config.js";
import { LABELS, isLabelMatch } from "../config.js";
import { isCIPassing } from "./merge-readiness.js";
import { logger } from "./logger.js";

export interface ReviewRequestsParams {
  prs: PROperations;
  ref: PRRef;
  config: ReviewRequestsConfig | null;
  trustedReviewers: string[];
  /** PR author login. Excluded from the eligible set. Normalized to lowercase internally. */
  author: string;
  /** HEAD commit SHA used to filter out reviewers who already reviewed this head. */
  headSha: string;
  /** Pre-fetched labels from the webhook payload. Used to verify candidate status. */
  currentLabels?: string[];
  /** True when the PR is a draft — skip request (draft PRs can't be reviewed). */
  draft?: boolean;
  log?: { info: (msg: string) => void; warn?: (msg: string) => void };
}

export type ReviewRequestsResult =
  | { action: "skipped"; reason: string }
  | { action: "requested"; reviewers: string[] }
  | { action: "noop"; reason: string };

/**
 * Request trusted reviewers on a candidate PR when it becomes reviewable.
 *
 * Idempotent: safe to call on every CI completion event without duplicate requests.
 * GitHub deduplicates review requests server-side for any logins already requested.
 */
export async function requestTrustedReviewers(
  params: ReviewRequestsParams
): Promise<ReviewRequestsResult> {
  const { prs, ref, config, trustedReviewers, author, headSha, log } = params;

  // 1. Feature disabled
  if (!config) {
    return { action: "skipped", reason: "feature disabled" };
  }

  // 2. Draft PRs can't receive reviews
  if (params.draft === true) {
    return { action: "skipped", reason: "PR is a draft" };
  }

  // 3. Must be a candidate PR
  const labels = params.currentLabels ?? await prs.getLabels(ref);
  if (!labels.some(l => isLabelMatch(l, LABELS.IMPLEMENTATION))) {
    return { action: "skipped", reason: "PR is not a candidate" };
  }

  // 4. CI must be passing — don't ping reviewers while checks are red or pending
  try {
    const ciPassing = await isCIPassing(prs, ref, headSha);
    if (!ciPassing) {
      return { action: "skipped", reason: "CI not passing" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const warnMsg = `[PR #${ref.prNumber}] Failed to check CI status: ${msg}`;
    if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
    return { action: "skipped", reason: "could not check CI status" };
  }

  // 5. Get reviewers who already have a pending request (fetch from API)
  let requestedReviewers: Set<string>;
  try {
    const pr = await prs.get(ref);
    requestedReviewers = new Set(pr.requestedReviewers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const warnMsg = `[PR #${ref.prNumber}] Failed to fetch requested reviewers: ${msg}`;
    if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
    return { action: "skipped", reason: "could not fetch PR state" };
  }

  // 6. Get reviewers who have already reviewed the current head
  let reviewedAtHead: Set<string>;
  try {
    reviewedAtHead = await prs.getReviewersAtCurrentHead(ref, headSha);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const warnMsg = `[PR #${ref.prNumber}] Failed to fetch reviews for head ${headSha}: ${msg}`;
    if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
    return { action: "skipped", reason: "could not fetch reviews" };
  }

  // 7. Compute eligible set: trusted − author − pending request − reviewed at head
  const authorLower = author.toLowerCase();
  const eligible = trustedReviewers.filter(
    (r) =>
      r !== authorLower &&
      !requestedReviewers.has(r) &&
      !reviewedAtHead.has(r)
  );

  if (eligible.length === 0) {
    return { action: "noop", reason: "no eligible reviewers" };
  }

  // 8-9. Walk the full sorted eligible list and collect up to `count` collaborators.
  // The collaborator check must happen *before* applying the count cap — slicing first
  // and filtering after can under-deliver: an alphabetically-earlier stale entry
  // consumes a slot and prevents a valid candidate further down from being reached.
  // POST /requested_reviewers rejects the entire batch with 422 if any login lacks
  // repo access, so we validate each candidate individually.
  const sorted = eligible.slice().sort();
  const toRequest: string[] = [];
  for (const login of sorted) {
    if (toRequest.length >= config.count) break;
    try {
      if (await prs.isCollaborator(ref, login)) {
        toRequest.push(login);
      } else {
        const warnMsg = `[PR #${ref.prNumber}] Skipping ${login}: not a repo collaborator`;
        if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
      }
    } catch (err) {
      // Transient API error (rate limit, server error) — can't determine status for this candidate.
      const msg = err instanceof Error ? err.message : String(err);
      const warnMsg = `[PR #${ref.prNumber}] Could not verify collaborator status for ${login}: ${msg}`;
      if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
    }
  }

  if (toRequest.length === 0) {
    return { action: "noop", reason: "no eligible collaborator reviewers" };
  }

  // 10. Request reviewers
  try {
    await prs.requestReviewers(ref, toRequest);
    log?.info(`[PR #${ref.prNumber}] Requested reviewers: ${toRequest.join(", ")}`);
    return { action: "requested", reviewers: toRequest };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const warnMsg = `[PR #${ref.prNumber}] Failed to request reviewers: ${msg}`;
    if (log?.warn) { log.warn(warnMsg); } else { logger.warn(warnMsg); }
    return { action: "skipped", reason: "request failed" };
  }
}
