import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestTrustedReviewers } from "./review-requests.js";
import type { ReviewRequestsConfig } from "./repo-config.js";
import { LABELS } from "../config.js";

vi.mock("./merge-readiness.js", () => ({
  isCIPassing: vi.fn().mockResolvedValue(true),
}));

import { isCIPassing } from "./merge-readiness.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Default CI state: passing. Override per-test for failure cases.
  vi.mocked(isCIPassing).mockResolvedValue(true);
});

function makeConfig(overrides?: Partial<ReviewRequestsConfig>): ReviewRequestsConfig {
  return { count: 2, ...overrides };
}

const REF = { owner: "hivemoot", repo: "test-repo", prNumber: 42 };
const HEAD_SHA = "abc123def456";

function createMockPROperations(overrides?: Record<string, unknown>) {
  return {
    getLabels: vi.fn().mockResolvedValue([LABELS.IMPLEMENTATION]),
    get: vi.fn().mockResolvedValue({
      author: "author",
      draft: false,
      requestedReviewers: [],
    }),
    getReviewersAtCurrentHead: vi.fn().mockResolvedValue(new Set<string>()),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// requestTrustedReviewers — feature disabled
// ─────────────────────────────────────────────────────────────────────────────

describe("requestTrustedReviewers — feature disabled", () => {
  it("skips when config is null", async () => {
    const prs = createMockPROperations();
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: null,
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
    });
    expect(result).toEqual({ action: "skipped", reason: "feature disabled" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("skips when PR is a draft", async () => {
    const prs = createMockPROperations();
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
      draft: true,
    });
    expect(result).toEqual({ action: "skipped", reason: "PR is a draft" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("skips when PR is not a candidate", async () => {
    const prs = createMockPROperations({
      getLabels: vi.fn().mockResolvedValue([]),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
    });
    expect(result).toEqual({ action: "skipped", reason: "PR is not a candidate" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("uses pre-fetched currentLabels to check candidate status without calling getLabels", async () => {
    const prs = createMockPROperations({
      getLabels: vi.fn().mockRejectedValue(new Error("should not be called")),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [], // no candidate label
    });
    expect(result).toEqual({ action: "skipped", reason: "PR is not a candidate" });
    expect(prs.getLabels).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestTrustedReviewers — noop cases
// ─────────────────────────────────────────────────────────────────────────────

describe("requestTrustedReviewers — noop", () => {
  it("returns noop when all trusted reviewers are the PR author", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "alice", draft: false, requestedReviewers: [] }),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice"],
      author: "alice",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "noop", reason: "no eligible reviewers" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("returns noop when all trusted reviewers already have pending requests", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({
        author: "charlie",
        draft: false,
        requestedReviewers: ["alice", "bob"],
      }),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "noop", reason: "no eligible reviewers" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("returns noop when all trusted reviewers already reviewed the current head", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "charlie", draft: false, requestedReviewers: [] }),
      getReviewersAtCurrentHead: vi.fn().mockResolvedValue(new Set(["alice", "bob"])),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "noop", reason: "no eligible reviewers" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestTrustedReviewers — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe("requestTrustedReviewers — requests reviewers", () => {
  it("requests all eligible reviewers when fewer than count", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "charlie", draft: false, requestedReviewers: [] }),
      getReviewersAtCurrentHead: vi.fn().mockResolvedValue(new Set<string>()),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 5 }),
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "requested", reviewers: ["alice", "bob"] });
    expect(prs.requestReviewers).toHaveBeenCalledWith(REF, ["alice", "bob"]);
  });

  it("limits requests to count and selects alphabetically", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "frank", draft: false, requestedReviewers: [] }),
      getReviewersAtCurrentHead: vi.fn().mockResolvedValue(new Set<string>()),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 2 }),
      trustedReviewers: ["charlie", "alice", "bob", "diana"],
      author: "frank",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    // Alphabetical order: alice, bob, charlie, diana → take first 2
    expect(result).toEqual({ action: "requested", reviewers: ["alice", "bob"] });
    expect(prs.requestReviewers).toHaveBeenCalledWith(REF, ["alice", "bob"]);
  });

  it("excludes the PR author from the request", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "alice", draft: false, requestedReviewers: [] }),
      getReviewersAtCurrentHead: vi.fn().mockResolvedValue(new Set<string>()),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 3 }),
      trustedReviewers: ["alice", "bob", "charlie"],
      author: "alice",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "requested", reviewers: ["bob", "charlie"] });
    expect(prs.requestReviewers).toHaveBeenCalledWith(REF, ["bob", "charlie"]);
  });

  it("excludes reviewers who already have a pending request", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({
        author: "frank",
        draft: false,
        requestedReviewers: ["alice"],
      }),
      getReviewersAtCurrentHead: vi.fn().mockResolvedValue(new Set<string>()),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 2 }),
      trustedReviewers: ["alice", "bob", "charlie"],
      author: "frank",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    // alice already requested, so bob and charlie are eligible
    expect(result).toEqual({ action: "requested", reviewers: ["bob", "charlie"] });
  });

  it("excludes reviewers who reviewed at the current head", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "frank", draft: false, requestedReviewers: [] }),
      getReviewersAtCurrentHead: vi.fn().mockResolvedValue(new Set(["bob"])),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 2 }),
      trustedReviewers: ["alice", "bob", "charlie"],
      author: "frank",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    // bob already reviewed this head, so alice and charlie are eligible
    expect(result).toEqual({ action: "requested", reviewers: ["alice", "charlie"] });
  });

  it("passes headSha to getReviewersAtCurrentHead", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "frank", draft: false, requestedReviewers: [] }),
    });
    await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice"],
      author: "frank",
      headSha: "specific-sha-123",
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(prs.getReviewersAtCurrentHead).toHaveBeenCalledWith(REF, "specific-sha-123");
  });

  it("normalizes author to lowercase for comparison", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "ALICE", draft: false, requestedReviewers: [] }),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 3 }),
      trustedReviewers: ["alice", "bob"],
      author: "ALICE", // uppercase — should still be excluded
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "requested", reviewers: ["bob"] });
  });

  it("fetches labels from API when currentLabels not provided", async () => {
    const prs = createMockPROperations({
      getLabels: vi.fn().mockResolvedValue([LABELS.IMPLEMENTATION]),
      get: vi.fn().mockResolvedValue({ author: "charlie", draft: false, requestedReviewers: [] }),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 1 }),
      trustedReviewers: ["alice"],
      author: "charlie",
      headSha: HEAD_SHA,
      // no currentLabels — should fetch
    });
    expect(prs.getLabels).toHaveBeenCalledWith(REF);
    expect(result).toEqual({ action: "requested", reviewers: ["alice"] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestTrustedReviewers — error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("requestTrustedReviewers — error handling", () => {
  it("returns skipped when prs.get() fails", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockRejectedValue(new Error("rate limit")),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "skipped", reason: "could not fetch PR state" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("returns skipped when getReviewersAtCurrentHead fails", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "charlie", draft: false, requestedReviewers: [] }),
      getReviewersAtCurrentHead: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "skipped", reason: "could not fetch reviews" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("returns skipped when requestReviewers fails", async () => {
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "charlie", draft: false, requestedReviewers: [] }),
      requestReviewers: vi.fn().mockRejectedValue(new Error("API error")),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "skipped", reason: "request failed" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requestTrustedReviewers — CI gate
// ─────────────────────────────────────────────────────────────────────────────

describe("requestTrustedReviewers — CI gate", () => {
  it("skips when CI is not passing", async () => {
    vi.mocked(isCIPassing).mockResolvedValue(false);
    const prs = createMockPROperations();
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice", "bob"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "skipped", reason: "CI not passing" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("skips when isCIPassing throws", async () => {
    vi.mocked(isCIPassing).mockRejectedValue(new Error("check-run API unavailable"));
    const prs = createMockPROperations();
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig(),
      trustedReviewers: ["alice"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "skipped", reason: "could not check CI status" });
    expect(prs.requestReviewers).not.toHaveBeenCalled();
  });

  it("proceeds when CI is passing", async () => {
    vi.mocked(isCIPassing).mockResolvedValue(true);
    const prs = createMockPROperations({
      get: vi.fn().mockResolvedValue({ author: "charlie", draft: false, requestedReviewers: [] }),
    });
    const result = await requestTrustedReviewers({
      prs,
      ref: REF,
      config: makeConfig({ count: 1 }),
      trustedReviewers: ["alice"],
      author: "charlie",
      headSha: HEAD_SHA,
      currentLabels: [LABELS.IMPLEMENTATION],
    });
    expect(result).toEqual({ action: "requested", reviewers: ["alice"] });
    expect(isCIPassing).toHaveBeenCalledWith(prs, REF, HEAD_SHA);
  });
});
