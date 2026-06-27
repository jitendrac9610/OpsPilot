export type VerificationStatus = "PASSED" | "FAILED" | "SKIPPED";
export type OverallRepairResult = "PASSED" | "FAILED" | "INCONCLUSIVE";

export interface VerificationComparison {
  buildBefore?: VerificationStatus;
  buildAfter: VerificationStatus;
  testsBefore?: VerificationStatus;
  testsAfter: VerificationStatus;
  replayBefore?: VerificationStatus;
  replayAfter: VerificationStatus;
  securityAfter: VerificationStatus;
  overallResult: OverallRepairResult;
}

export function classifyVerification(input: {
  buildSuccess: boolean;
  testSuccess: boolean;
  replaySuccess: boolean;
  securitySuccess: boolean;
  replaySkipped?: boolean;
}): VerificationComparison {
  const replayAfter: VerificationStatus = input.replaySkipped
    ? "SKIPPED"
    : input.replaySuccess ? "PASSED" : "FAILED";
  const overallResult: OverallRepairResult = replayAfter === "SKIPPED"
    ? "INCONCLUSIVE"
    : input.buildSuccess && input.testSuccess && input.replaySuccess && input.securitySuccess
      ? "PASSED"
      : "FAILED";

  return {
    buildAfter: input.buildSuccess ? "PASSED" : "FAILED",
    testsAfter: input.testSuccess ? "PASSED" : "FAILED",
    replayAfter,
    securityAfter: input.securitySuccess ? "PASSED" : "FAILED",
    overallResult
  };
}
