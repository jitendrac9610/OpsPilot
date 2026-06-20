import fs from "fs";
import path from "path";

export interface ClassifiedFile {
  relativePath: string;
  absolutePath: string;
  language: string; // 'TypeScript' | 'JavaScript' | 'Python' | 'Java' | 'Go' | 'Unknown'
  isBinary: boolean;
  isSecret: boolean;
}

// Patterns of secrets we want to exclude
const SECRET_REGEXES = [
  /-----BEGIN [A-Z ]+ (?:PRIVATE KEY|RSA PRIVATE KEY)-----/i,
  /sk_test_[a-zA-Z0-9]{24,100}/, // Stripe secret keys
  /clerk_test_[a-zA-Z0-9]+/i, // Clerk secret keys
  /(postgres|mongodb|redis):\/\/[A-Za-z0-9_]+:[A-Za-z0-9_]+@/i, // DB connections with credentials
  /secret_?key|api_?key|password|passwd|private_?key|token/i
];

const EXCLUDED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".gz", ".tar",
  ".exe", ".dll", ".so", ".dylib", ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".db", ".sqlite", ".bin", ".env", ".env.local"
]);

const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", ".turbo", "target", "bin", "obj", ".idea", ".vscode"
]);

export function classifyFile(relativePath: string, absolutePath: string): ClassifiedFile {
  const ext = path.extname(relativePath).toLowerCase();
  
  // 1. Check binary by extension
  const isBinary = EXCLUDED_EXTENSIONS.has(ext);
  
  // 2. Determine language
  let language = "Unknown";
  if (!isBinary) {
    if (ext === ".ts" || ext === ".tsx") {
      language = "TypeScript";
    } else if (ext === ".js" || ext === ".jsx") {
      language = "JavaScript";
    } else if (ext === ".py") {
      language = "Python";
    } else if (ext === ".java") {
      language = "Java";
    } else if (ext === ".go") {
      language = "Go";
    }
  }

  // 3. Scan for secrets
  let isSecret = false;
  const filename = path.basename(relativePath).toLowerCase();
  if (
    filename === ".env" ||
    filename.includes(".pem") ||
    filename.includes(".key") ||
    filename.includes("credentials")
  ) {
    isSecret = true;
  } else if (!isBinary && fs.existsSync(absolutePath)) {
    try {
      const content = fs.readFileSync(absolutePath, "utf-8");
      // Check first 10KB to avoid heavy regex on massive text files
      const prefix = content.slice(0, 10000);
      for (const regex of SECRET_REGEXES) {
        if (regex.test(prefix)) {
          isSecret = true;
          break;
        }
      }
    } catch {
      // Ignore reading errors (e.g. permission or lock issues)
    }
  }

  return {
    relativePath,
    absolutePath,
    language,
    isBinary,
    isSecret
  };
}

export function shouldExcludeFile(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) {
      return true;
    }
  }
  return false;
}
