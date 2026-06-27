import jwt from "jsonwebtoken";
import { config, logger } from "@opspilot/shared";

export class GitHubClient {
  private appId: string;
  private privateKey: string;

  constructor() {
    this.appId = config.github.appId;
    this.privateKey = config.github.privateKey.replace(/\\n/g, "\n");
  }

  // Generates a short-lived JSON Web Token signed with the App private key
  private getAppJwt(): string {
    if (!this.appId || !this.privateKey) {
      throw new Error("GITHUB_APP_CREDENTIALS_MISSING: GitHub App ID and private key are required.");
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iat: now - 60, // Issued 60s ago to allow clock drift
      exp: now + (10 * 60), // Expires in 10 minutes
      iss: this.appId
    };

    return jwt.sign(payload, this.privateKey, { algorithm: "RS256" });
  }

  // Exchanges the App JWT for a short-lived installation access token
  async getInstallationToken(installationId: string): Promise<string> {
    if ((!this.appId || !this.privateKey) && config.isDemoMode) {
      logger.info({ installationId }, "Using demo GitHub installation token");
      return `mock_token_inst_${installationId}`;
    }

    try {
      const appJwt = this.getAppJwt();
      const res = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${appJwt}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "OpsPilot-App"
        }
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub token exchange failed: ${res.status} ${text || res.statusText}`);
      }

      const data = await res.json() as { token: string };
      return data.token;
    } catch (err) {
      logger.error({ err, installationId }, "Failed to fetch GitHub installation access token");
      throw err;
    }
  }

  // Creates or updates a GitHub Status Check on a commit
  async createCommitStatus(
    token: string,
    owner: string,
    repo: string,
    sha: string,
    state: "pending" | "success" | "failure" | "error",
    description: string,
    targetUrl?: string
  ): Promise<void> {
    if (token.startsWith("mock_")) {
      if (!config.isDemoMode) {
        throw new Error("GITHUB_MOCK_TOKEN_REJECTED: Mock GitHub tokens are allowed only in demo mode.");
      }
      logger.info({ owner, repo, sha, state, description }, "Simulating GitHub status check update");
      return;
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "OpsPilot-App"
        },
        body: JSON.stringify({
          state,
          description,
          context: "OpsPilot Verification",
          target_url: targetUrl
        })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub status update failed: ${res.status} ${text || res.statusText}`);
      }
    } catch (err) {
      logger.error({ err, sha }, "Error updating commit status on GitHub");
      throw err;
    }
  }

  // Creates a Pull Request from a branch
  async createPullRequest(
    token: string,
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string
  ): Promise<{ number: number; url: string }> {
    if (token.startsWith("mock_")) {
      if (!config.isDemoMode) {
        throw new Error("GITHUB_MOCK_TOKEN_REJECTED: Mock GitHub tokens are allowed only in demo mode.");
      }
      logger.info({ owner, repo, title, head, base }, "Simulating pull request creation");
      return { number: 42, url: `https://github.com/${owner}/${repo}/pull/42` };
    }

    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "OpsPilot-App"
        },
        body: JSON.stringify({ title, body, head, base })
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub pull request creation failed: ${res.status} ${text || res.statusText}`);
      }

      const data = await res.json() as { number: number; html_url: string };
      return { number: data.number, url: data.html_url };
    } catch (err) {
      logger.error({ err, owner, repo }, "Error creating pull request on GitHub");
      throw err;
    }
  }
}
