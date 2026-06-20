import fs from "fs";

const content = fs.readFileSync("c:\\Users\\jiten\\OpsPilot\\PHASES.md", "utf-8");
const lines = content.split("\n");
lines.forEach((line, index) => {
  if (line.includes("PHASE")) {
    console.log(`${index + 1}: ${line}`);
  }
});
