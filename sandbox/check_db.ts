import { prisma } from "../packages/database/src/index.js";

async function main() {
  const snapshots = await prisma.repositorySnapshot.findMany();
  console.log("--- SNAPSHOTS ---");
  console.log(snapshots);

  const versions = await prisma.architectureVersion.findMany();
  console.log("--- ARCHITECTURE VERSIONS ---");
  console.log(versions);

  const nodes = await prisma.graphNode.findMany();
  console.log("--- GRAPH NODES ---");
  console.log(nodes.map(n => ({ id: n.id, name: n.name, type: n.type })));

  const edges = await prisma.graphEdge.findMany();
  console.log("--- GRAPH EDGES ---");
  console.log(edges.map(e => ({ source: e.source, target: e.target, type: e.type })));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
