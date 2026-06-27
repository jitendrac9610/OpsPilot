import { OverallRepairResult } from "./verifier.js";

export interface RepairCandidateScore {
  id: string;
  verificationResult: OverallRepairResult;
  risk: "LOW" | "MEDIUM" | "HIGH";
  changedFiles: number;
  changedLines: number;
  testsPassed: boolean;
  replayPassed: boolean;
}

const RISK_SCORE = {
  LOW: 0,
  MEDIUM: 20,
  HIGH: 50
} as const;

export function rankRepairCandidates<T extends RepairCandidateScore>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

export function scoreCandidate(candidate: RepairCandidateScore): number {
  let score = 0;
  if (candidate.verificationResult === "PASSED") score += 100;
  if (candidate.verificationResult === "INCONCLUSIVE") score += 25;
  if (candidate.testsPassed) score += 20;
  if (candidate.replayPassed) score += 30;
  score -= RISK_SCORE[candidate.risk];
  score -= Math.min(candidate.changedFiles * 3, 30);
  score -= Math.min(Math.ceil(candidate.changedLines / 25), 20);
  return score;
}
