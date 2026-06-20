import { prisma } from "../packages/database/src/index.js";
import jwt from "jsonwebtoken";
import { config } from "../packages/shared/src/config.js";

async function main() {
  const user = await prisma.user.findFirst();
  if (!user) {
    console.log("No user found");
    return;
  }

  const repo = await prisma.repository.findFirst();
  if (!repo) {
    console.log("No repository found");
    return;
  }

  const token = jwt.sign({ userId: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: "24h"
  });

  const url = `http://localhost:4000/api/repositories/${repo.id}/architecture`;
  console.log("Calling API:", url);

  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`
    }
  });

  if (!res.ok) {
    console.log("Error status:", res.status);
    console.log(await res.text());
    return;
  }

  const data = await res.json();
  console.log("API response status OK. Nodes count:", data.nodes?.length, "Edges count:", data.edges?.length);
  console.log("Sample Node:", data.nodes?.[0]);
  console.log("Sample Edge:", data.edges?.[0]);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
