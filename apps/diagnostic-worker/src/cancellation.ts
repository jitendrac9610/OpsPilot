import { prisma } from "@opspilot/database";

export async function isDiagnosticRunCancelled(runId: string): Promise<boolean> {
  const run = await prisma.diagnosticRun.findUnique({
    where: { id: runId },
    select: { status: true }
  });
  return run?.status === "CANCELLED";
}
