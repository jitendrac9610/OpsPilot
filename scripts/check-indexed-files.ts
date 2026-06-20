import { prisma } from "../packages/database/src/index";

async function main() {
  const snapshotId = "cmqlhjdnp000024tpusrg19fm"; // talent-iq2 latest snapshot ID

  console.log(`=== ARCHITECTURE VERSIONS FOR SNAPSHOT: ${snapshotId} ===`);
  const versions = await prisma.architectureVersion.findMany({
    where: { snapshotId }
  });
  console.log(versions);

  if (versions.length > 0) {
    const versionId = versions[versions.length - 1].id;
    console.log(`\n=== GRAPH NODES FOR VERSION: ${versionId} ===`);
    const nodes = await prisma.graphNode.findMany({
      where: { versionId }
    });
    console.log(`Total nodes: ${nodes.length}`);
    console.log(JSON.stringify(nodes.slice(0, 15), null, 2));

    console.log(`\n=== GRAPH EDGES FOR VERSION: ${versionId} ===`);
    const edges = await prisma.graphEdge.findMany({
      where: { versionId }
    });
    console.log(`Total edges: ${edges.length}`);
    console.log(JSON.stringify(edges.slice(0, 15), null, 2));
  }
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
