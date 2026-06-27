import { createCommitSnapshot as createRepositoryCommitSnapshot } from "@opspilot/repository-intelligence";

export async function createCommitSnapshot(
  repositoryId: string,
  gitUrl: string,
  commitSha: string,
  branch: string = "main"
): Promise<string> {
  const snapshot = await createRepositoryCommitSnapshot({
    repositoryId,
    gitUrl,
    commitSha,
    branch,
    source: "github-worker"
  });

  return snapshot.archiveUrl;
}
