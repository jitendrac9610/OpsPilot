import fs from "node:fs";
import path from "node:path";
import { BrowserContract } from "@opspilot/schemas";

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "sandbox"]);
const SOURCE_EXTENSIONS = [".tsx", ".jsx", ".ts", ".js"];

async function findSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [path.resolve(dir)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
        pending.push(absolute);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        files.push(absolute);
      }
    }
  }
  return files;
}

export async function discoverBrowserContracts(repoDirectory: string): Promise<BrowserContract[]> {
  const sourceFiles = await findSourceFiles(repoDirectory);
  const contracts: BrowserContract[] = [];

  for (const absolutePath of sourceFiles) {
    const content = await fs.promises.readFile(absolutePath, "utf8").catch(() => "");
    if (!content) continue;

    const relativePath = path.relative(repoDirectory, absolutePath).replace(/\\/g, "/");

    const appMatch = relativePath.match(/(?:^|\/)app\/(.+)\/page\.(?:tsx|jsx|ts|js)$/);
    const pagesMatch = relativePath.match(/(?:^|\/)pages\/(.+)\.(?:tsx|jsx|ts|js)$/);
    const isRootAppPage = relativePath.endsWith("app/page.tsx") || relativePath.endsWith("app/page.jsx");
    const isRootPagesPage = relativePath.endsWith("pages/index.tsx") || relativePath.endsWith("pages/index.jsx");

    let routePath = "";
    if (isRootAppPage || isRootPagesPage) {
      routePath = "/";
    } else if (appMatch) {
      routePath = `/${appMatch[1].replace(/\[([^\]]+)\]/g, ":$1")}`;
    } else if (pagesMatch) {
      routePath = `/${pagesMatch[1].replace(/\[([^\]]+)\]/g, ":$1")}`;
    }

    if (!routePath) continue;

    const elements: BrowserContract["elements"] = [];

    // 1. Scan for inputs: <input type="..." name="..." placeholder="..." data-testid="..." />
    const inputRegex = /<input\b[^>]*>/gi;
    let match;
    while ((match = inputRegex.exec(content)) !== null) {
      const tag = match[0];
      const nameAttr = tag.match(/name\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/i);
      const typeAttr = tag.match(/type\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/i);
      const placeholderAttr = tag.match(/placeholder\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/i);
      const testIdAttr = tag.match(/(?:data-testid|testid)\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/i);

      const name = nameAttr ? (nameAttr[1] || nameAttr[2]) : undefined;
      const type = typeAttr ? (typeAttr[1] || typeAttr[2]) : "text";
      const placeholder = placeholderAttr ? (placeholderAttr[1] || placeholderAttr[2]) : undefined;
      const testId = testIdAttr ? (testIdAttr[1] || testIdAttr[2]) : undefined;

      let selector = `input`;
      if (testId) {
        selector = `[data-testid="${testId}"]`;
      } else if (name) {
        selector = `input[name="${name}"]`;
      } else if (placeholder) {
        selector = `input[placeholder="${placeholder}"]`;
      }

      elements.push({
        type: type === "checkbox" ? "checkbox" : "input",
        selector,
        name,
        placeholder,
        testId
      });
    }

    // 2. Scan for buttons: <button ...>...</button>
    const buttonRegex = /<button\b[^>]*>([\s\S]*?)<\/button>/gi;
    while ((match = buttonRegex.exec(content)) !== null) {
      const tag = match[0];
      const text = match[1].replace(/<[^>]*>/g, "").trim();
      const testIdAttr = tag.match(/(?:data-testid|testid)\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/i);
      const testId = testIdAttr ? (testIdAttr[1] || testIdAttr[2]) : undefined;

      let selector = `button`;
      if (testId) {
        selector = `[data-testid="${testId}"]`;
      } else if (text) {
        selector = `button:has-text("${text}")`;
      }

      elements.push({
        type: "button",
        selector,
        label: text,
        testId
      });
    }

    // 3. Scan for selects: <select ...>...</select>
    const selectRegex = /<select\b[^>]*>/gi;
    while ((match = selectRegex.exec(content)) !== null) {
      const tag = match[0];
      const nameAttr = tag.match(/name\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/i);
      const testIdAttr = tag.match(/(?:data-testid|testid)\s*=\s*(?:['"]([^'"]+)['"]|{([^}]+)})/i);

      const name = nameAttr ? (nameAttr[1] || nameAttr[2]) : undefined;
      const testId = testIdAttr ? (testIdAttr[1] || testIdAttr[2]) : undefined;

      let selector = `select`;
      if (testId) {
        selector = `[data-testid="${testId}"]`;
      } else if (name) {
        selector = `select[name="${name}"]`;
      }

      elements.push({
        type: "select",
        selector,
        name,
        testId
      });
    }

    contracts.push({
      id: `browser-${routePath.replace(/\//g, "-").replace(/^-|-$/g, "") || "root"}`,
      path: routePath,
      elements,
      source: {
        file: relativePath,
        line: 1
      }
    });
  }

  return contracts;
}
