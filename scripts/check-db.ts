import { prisma } from "../packages/database/src/index";

async function main() {
  console.log("=== REPOSITORIES ===");
  const repos = await prisma.repository.findMany();
  console.log(JSON.stringify(repos, null, 2));

  console.log("\n=== SNAPSHOTS ===");
  const snapshots = await prisma.repositorySnapshot.findMany();
  console.log(JSON.stringify(snapshots, null, 2));

  console.log("\n=== RECENT AUDIT LOGS ===");
  const logs = await prisma.auditLog.findMany({
    orderBy: { timestamp: "desc" },
    take: 20
  });
  console.log(JSON.stringify(logs, null, 2));
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
