import { config, logger } from "@opspilot/shared";

/**
 * Helper to compute a simple hash of a string.
 */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Local Hashing Vectorizer that projects text tokens into a 128-dimensional L2-normalized vector.
 * This ensures deterministic fallback vectors for local execution and testing.
 */
export function getLocalEmbedding(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const vector = Array.from({ length: 128 }, () => 0);

  if (tokens.length === 0) {
    return vector;
  }

  // Count term frequencies
  const counts: Record<string, number> = {};
  for (const token of tokens) {
    counts[token] = (counts[token] || 0) + 1;
  }

  // Project tokens into the 128-dimensional vector
  for (const [token, count] of Object.entries(counts)) {
    const tf = count / tokens.length;
    const index = hashString(token) % 128;
    vector[index] += tf;
  }

  // L2 Normalization (so dot product equals Cosine Similarity)
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < 128; i++) {
      vector[i] = vector[i] / magnitude;
    }
  }

  return vector;
}

/**
 * Retrieves the embedding vector for the given text.
 * Defaults to Google Gemini text-embedding-004 if GEMINI_API_KEY is configured,
 * otherwise falls back transparently to the Local Hashing Vectorizer.
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const apiKey = config.geminiApiKey;

  if (!apiKey) {
    logger.debug("No GEMINI_API_KEY configured. Falling back to Local Hashing Vectorizer.");
    return getLocalEmbedding(text);
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: {
          parts: [{ text }],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({ errorText, status: response.status }, "Gemini Embedding API call failed. Falling back to Local Hashing Vectorizer.");
      return getLocalEmbedding(text);
    }

    const data = (await response.json()) as any;
    if (data?.embedding?.values) {
      return data.embedding.values as number[];
    }

    logger.warn({ data }, "Unexpected response format from Gemini Embedding API. Falling back to Local Hashing Vectorizer.");
    return getLocalEmbedding(text);
  } catch (err) {
    logger.warn({ err }, "Error fetching Gemini embedding. Falling back to Local Hashing Vectorizer.");
    return getLocalEmbedding(text);
  }
}

/**
 * Rewrites a query using Gemini if available to expand/clarify intent,
 * otherwise returns the original query.
 */
export async function rewriteQuery(query: string, errorContext?: string): Promise<string> {
  const geminiApiKey = config.geminiApiKey;
  const openrouterApiKey = config.openrouterApiKey;

  if (!geminiApiKey && !openrouterApiKey) {
    return query;
  }

  const prompt = `You are a RAG query rewriter for software incidents.
Rewrite the following search query to improve retrieval of relevant source code, configuration files, and documentation.
Keep it concise, and output ONLY the rewritten query text. Do not add explanations or formatting.

Query: "${query}"
${errorContext ? `Additional Error Context: "${errorContext}"` : ""}`;

  if (geminiApiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 100,
          },
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          return text.trim();
        }
      }
    } catch (err) {
      logger.debug({ err }, "Error rewriting query with Gemini");
    }
  } else if (openrouterApiKey) {
    try {
      const url = "https://openrouter.ai/api/v1/chat/completions";
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${openrouterApiKey}`,
          "HTTP-Referer": "https://opspilot.ai",
          "X-Title": "OpsPilot"
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 100
        })
      });


      if (response.ok) {
        const data = (await response.json()) as any;
        const text = data?.choices?.[0]?.message?.content;
        if (text) {
          return text.trim();
        }
      }
    } catch (err) {
      logger.debug({ err }, "Error rewriting query with OpenRouter");
    }
  }

  return query;
}

