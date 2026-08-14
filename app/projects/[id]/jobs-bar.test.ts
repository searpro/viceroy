import { describe, it, expect } from "vitest";
import { jobCounts } from "./jobs-bar";
import type { Job } from "./detail-types";

function job(overrides: Partial<Job>): Job {
  return {
    id: "j1",
    type: "synopsis",
    status: "queued",
    progress: 0,
    attempts: 0,
    maxAttempts: 3,
    error: null,
    ...overrides,
  };
}

describe("jobCounts", () => {
  it("counts queued and running jobs as active", () => {
    const jobs = [job({ status: "queued" }), job({ status: "running" }), job({ status: "succeeded" })];
    expect(jobCounts(jobs).active).toBe(2);
  });

  it("counts failed jobs separately from active ones", () => {
    const jobs = [job({ status: "failed" }), job({ status: "aborted" }), job({ status: "succeeded" })];
    const counts = jobCounts(jobs);
    expect(counts.failed).toBe(1);
    expect(counts.active).toBe(0);
  });

  it("returns zero counts for an empty job list", () => {
    expect(jobCounts([])).toEqual({ active: 0, failed: 0 });
  });
});
