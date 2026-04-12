import { describe, it, expect, vi, beforeEach } from "vitest";
import { rerequestBlockingReviewers } from "./review-rerequests.js";
import type { PROperations } from "./pr-operations.js";
import type { PRRef } from "./types.js";
import type { PRConfig } from "./repo-config.js";
import { LABELS } from "../config.js";

/**
 * Tests for rerequestBlockingReviewers
 *
 * Verifies the re-request flow: only fires for candidate PRs when CI passes
 * and trusted reviewers have CHANGES_REQUESTED on a prior head.
 */

const testRef: PRRef = { owner: "testorg", repo: "testrepo", prNumber: 42 };
const headSha = "new-sha-789";
const priorSha = "old-sha-123";

const makeConfig = (
  rerequestBlockers: boolean,
  trustedReviewers: string[] = ["alice", "bob"]
): PRConfig => ({
  staleDays: null,
  maxPRsPerIssue: 3,
  trustedReviewers,
  intake: [{ method: "auto" as const }],
  mergeReady: null,
  automerge: null,
  reviewRequests: { rerequestBlockers },
});

const makePR = (overrides: Partial<{
  author: string;
  headSha: string;
  draft: boolean;
  state: string;
  labels: string[];
}> = {}) => ({
  author: "author-user",
  headSha,
  draft: false,
  state: "open",
  labels: [LABELS.IMPLEMENTATION],
  ...overrides,
});

function makePRSpy(overrides: Partial<PROperations> = {}): PROperations {
  return {
    getBlockingReviewers: vi.fn().mockResolvedValue(new Set(["alice"])),
    getRequestedReviewers: vi.fn().mockResolvedValue(new Set()),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
    getCheckRunsForRef: vi.fn().mockResolvedValue({
      totalCount: 1,
      checkRuns: [{ id: 1, status: "completed", conclusion: "success" }],
    }),
    getCombinedStatus: vi.fn().mockResolvedValue({
      state: "success",
      totalCount: 0,
      statuses: [],
    }),
    ...overrides,
  } as unknown as PROperations;
}

describe("rerequestBlockingReviewers", () => {
  it("no-ops when reviewRequests.rerequestBlockers is false", async () => {
    const prs = makePRSpy();
    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR(),
      prConfig: makeConfig(false),
    });

    expect(prs.getBlockingReviewers).not.toHaveBeenCalled();
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("no-ops when reviewRequests is null", async () => {
    const prs = makePRSpy();
    const config = makeConfig(true);
    config.reviewRequests = null;

    await rerequestBlockingReviewers({ prs, ref: testRef, pr: makePR(), prConfig: config });

    expect(prs.getBlockingReviewers).not.toHaveBeenCalled();
  });

  it("no-ops when trustedReviewers is empty", async () => {
    const prs = makePRSpy();
    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR(),
      prConfig: makeConfig(true, []),
    });

    expect(prs.getBlockingReviewers).not.toHaveBeenCalled();
  });

  it("no-ops when PR is a draft", async () => {
    const prs = makePRSpy();
    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR({ draft: true }),
      prConfig: makeConfig(true),
    });

    expect(prs.getBlockingReviewers).not.toHaveBeenCalled();
  });

  it("no-ops when PR state is not open", async () => {
    const prs = makePRSpy();
    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR({ state: "closed" }),
      prConfig: makeConfig(true),
    });

    expect(prs.getBlockingReviewers).not.toHaveBeenCalled();
  });

  it("no-ops when PR is not a candidate", async () => {
    const prs = makePRSpy();
    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR({ labels: [] }),
      prConfig: makeConfig(true),
    });

    expect(prs.getCheckRunsForRef).not.toHaveBeenCalled();
    expect(prs.getBlockingReviewers).not.toHaveBeenCalled();
  });

  it("no-ops when CI is not passing", async () => {
    const prs = makePRSpy({
      getCheckRunsForRef: vi.fn().mockResolvedValue({
        totalCount: 1,
        checkRuns: [{ id: 1, status: "completed", conclusion: "failure" }],
      }),
    });

    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR(),
      prConfig: makeConfig(true),
    });

    expect(prs.getBlockingReviewers).not.toHaveBeenCalled();
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("requests blocking reviewers when CI passes and conditions are met", async () => {
    const prs = makePRSpy();

    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR(),
      prConfig: makeConfig(true),
    });

    expect(prs.requestReviewers).toHaveBeenCalledWith(testRef, ["alice"]);
  });

  it("excludes the PR author from re-request", async () => {
    const prs = makePRSpy({
      // alice blocked the PR; alice is also the author
      getBlockingReviewers: vi.fn().mockResolvedValue(new Set(["alice"])),
    });

    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR({ author: "alice" }),
      prConfig: makeConfig(true),
    });

    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("excludes reviewers who already have a pending request", async () => {
    const prs = makePRSpy({
      getBlockingReviewers: vi.fn().mockResolvedValue(new Set(["alice"])),
      getRequestedReviewers: vi.fn().mockResolvedValue(new Set(["alice"])),
    });

    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR(),
      prConfig: makeConfig(true),
    });

    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("sends re-requests in alphabetical order", async () => {
    const prs = makePRSpy({
      getBlockingReviewers: vi.fn().mockResolvedValue(new Set(["carol", "alice", "bob"])),
    });

    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR(),
      prConfig: makeConfig(true, ["alice", "bob", "carol"]),
    });

    expect(prs.requestReviewers).toHaveBeenCalledWith(testRef, ["alice", "bob", "carol"]);
  });

  it("no-ops when no blocking reviewers found", async () => {
    const prs = makePRSpy({
      getBlockingReviewers: vi.fn().mockResolvedValue(new Set()),
    });

    await rerequestBlockingReviewers({
      prs,
      ref: testRef,
      pr: makePR(),
      prConfig: makeConfig(true),
    });

    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });
});
