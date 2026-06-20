import { prisma } from "@opspilot/database";
import { getEmbedding } from "../utils/llm.js";

export interface CodeChunkResult {
  id: string;
  fileId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
}

/**
 * Basic tokenizer for BM25 and vector projection
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Computes the dot product of two arrays (L2 normalized vectors)
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dotProduct += a[i] * b[i];
  }
  return dotProduct;
}

/**
 * Code RAG Store: Methods to search for CodeChunk records using hybrid Vector + Lexical (BM25) search,
 * and exact symbol / error substring matching.
 */
export class CodeStore {
  /**
   * Search for CodeChunks using a hybrid BM25 + Vector Similarity (RRF) ranker
   */
  async searchCode(
    query: string,
    options: { snapshotId: string; limit?: number }
  ): Promise<CodeChunkResult[]> {
    const limit = options.limit ?? 10;

    // 1. Fetch files in this snapshot
    const files = await prisma.repositoryFile.findMany({
      where: { snapshotId: options.snapshotId },
    });
    if (files.length === 0) return [];

    const fileMap = new Map(files.map((f) => [f.id, f.path]));
    const fileIds = files.map((f) => f.id);

    // 2. Fetch chunks and their embeddings
    const chunks = await prisma.codeChunk.findMany({
      where: { fileId: { in: fileIds } },
    });
    if (chunks.length === 0) return [];

    const embeddings = await prisma.chunkEmbedding.findMany({
      where: { chunkId: { in: chunks.map((c) => c.id) } },
    });

    const embeddingMap = new Map(
      embeddings.map((e) => {
        try {
          return [e.chunkId, JSON.parse(e.embedding) as number[]];
        } catch {
          return [e.chunkId, []];
        }
      })
    );

    // 3. Vector Similarity Ranking
    const queryVector = await getEmbedding(query);
    const vectorScores: Array<{ chunkId: string; score: number }> = [];

    for (const chunk of chunks) {
      const chunkVector = embeddingMap.get(chunk.id);
      if (chunkVector && chunkVector.length > 0) {
        const score = cosineSimilarity(queryVector, chunkVector);
        vectorScores.push({ chunkId: chunk.id, score });
      } else {
        vectorScores.push({ chunkId: chunk.id, score: 0 });
      }
    }

    // Sort by vector score desc
    vectorScores.sort((a, b) => b.score - a.score);
    const vectorRankMap = new Map(vectorScores.map((item, idx) => [item.chunkId, idx + 1]));

    // 4. BM25 Lexical Ranking
    const queryTerms = tokenize(query);
    const lexicalScores: Array<{ chunkId: string; score: number }> = [];

    if (queryTerms.length > 0) {
      // Calculate corpus statistics
      const chunkTokensMap = new Map<string, string[]>();
      const docFrequencies: Record<string, number> = {};
      let totalLength = 0;

      for (const chunk of chunks) {
        const tokens = tokenize(chunk.content);
        chunkTokensMap.set(chunk.id, tokens);
        totalLength += tokens.length;

        const uniqueTokens = new Set(tokens);
        for (const token of uniqueTokens) {
          docFrequencies[token] = (docFrequencies[token] || 0) + 1;
        }
      }

      const N = chunks.length;
      const avgdl = totalLength / N;
      const k1 = 1.5;
      const b = 0.75;

      for (const chunk of chunks) {
        let score = 0;
        const tokens = chunkTokensMap.get(chunk.id) || [];
        const termCounts: Record<string, number> = {};
        for (const token of tokens) {
          termCounts[token] = (termCounts[token] || 0) + 1;
        }

        for (const term of queryTerms) {
          const f = termCounts[term] || 0;
          const df = docFrequencies[term] || 0;
          if (df === 0) continue;

          // IDF
          const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
          // TF component
          const tf = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (tokens.length / avgdl)));
          score += idf * tf;
        }
        lexicalScores.push({ chunkId: chunk.id, score });
      }
    } else {
      for (const chunk of chunks) {
        lexicalScores.push({ chunkId: chunk.id, score: 0 });
      }
    }

    // Sort by lexical score desc
    lexicalScores.sort((a, b) => b.score - a.score);
    const lexicalRankMap = new Map(lexicalScores.map((item, idx) => [item.chunkId, idx + 1]));

    // 5. Reciprocal Rank Fusion (RRF)
    const kRRF = 60;
    const fusedResults: Array<{ chunk: typeof chunks[0]; score: number }> = [];

    for (const chunk of chunks) {
      const vRank = vectorRankMap.get(chunk.id) ?? chunks.length;
      const lRank = lexicalRankMap.get(chunk.id) ?? chunks.length;

      const rrfScore = 1 / (kRRF + vRank) + 1 / (kRRF + lRank);
      fusedResults.push({ chunk, score: rrfScore });
    }

    // Sort by RRF score desc
    fusedResults.sort((a, b) => b.score - a.score);

    // 6. Map and return
    return fusedResults.slice(0, limit).map(({ chunk, score }) => ({
      id: chunk.id,
      fileId: chunk.fileId,
      filePath: fileMap.get(chunk.fileId) || "unknown",
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score,
    }));
  }

  /**
   * Search for exact symbol match or code containing specific error substrings
   */
  async searchExact(
    symbol: string,
    errorSubstring: string,
    snapshotId: string
  ): Promise<CodeChunkResult[]> {
    const files = await prisma.repositoryFile.findMany({
      where: { snapshotId },
    });
    if (files.length === 0) return [];

    const fileMap = new Map(files.map((f) => [f.id, f.path]));
    const fileIds = files.map((f) => f.id);

    // 1. Symbol search in db symbols table
    const dbSymbols = await prisma.symbol.findMany({
      where: {
        fileId: { in: fileIds },
        name: { contains: symbol, mode: "insensitive" },
      },
    });

    const matchedChunkIds = new Set<string>();
    const results: CodeChunkResult[] = [];

    // Fetch chunks matching symbols
    if (dbSymbols.length > 0) {
      for (const sym of dbSymbols) {
        const chunks = await prisma.codeChunk.findMany({
          where: {
            fileId: sym.fileId,
            startLine: { lte: sym.line },
            endLine: { gte: sym.line },
          },
        });

        for (const chunk of chunks) {
          if (!matchedChunkIds.has(chunk.id)) {
            matchedChunkIds.add(chunk.id);
            results.push({
              id: chunk.id,
              fileId: chunk.fileId,
              filePath: fileMap.get(chunk.fileId) || "unknown",
              content: chunk.content,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              score: 1.0,
            });
          }
        }
      }
    }

    // 2. Error substring matching directly in code chunks
    if (errorSubstring) {
      const chunksWithSubstring = await prisma.codeChunk.findMany({
        where: {
          fileId: { in: fileIds },
          content: { contains: errorSubstring, mode: "insensitive" },
        },
      });

      for (const chunk of chunksWithSubstring) {
        if (!matchedChunkIds.has(chunk.id)) {
          matchedChunkIds.add(chunk.id);
          results.push({
            id: chunk.id,
            fileId: chunk.fileId,
            filePath: fileMap.get(chunk.fileId) || "unknown",
            content: chunk.content,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            score: 0.8,
          });
        }
      }
    }

    return results;
  }
}
