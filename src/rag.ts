// Copyright 2024, UChicago Argonne, LLC
// All Rights Reserved
// Software Name: NEML2 -- the New Engineering material Model Library, version 2
// By: Argonne National Laboratory
// OPEN SOURCE LICENSE (MIT)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

/**
 * Retrieval step of the RAG pipeline.
 *
 * Embeds the user's query with the same model used during ingestion (see
 * doc/chatbot/ingest/), then asks Vectorize for the top-K most similar
 * chunks. The chunk text + citation metadata travel back to prompt.ts.
 *
 * The Vectorize index must be populated by the ingest job before this returns
 * anything useful — an empty index means an empty result set, and the prompt
 * builder will hand the model the "no context" branch.
 */

import type { RetrievedChunk } from "./prompt.js";

interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  EMBED_MODEL: string;
  TOP_K: string;
  GATEWAY_ID?: string;
}

/**
 * Embed the query, query Vectorize for top-K matches, and unpack each match's
 * metadata into a `RetrievedChunk`.
 *
 * The metadata fields read here (`text`, `url`, `title`, `ref`, `anchor`)
 * MUST match the keys written by the ingest job (`ingest.py`'s `Vector.metadata`).
 * If those names ever drift, the chunks will still be retrieved but every
 * field comes back empty and the model loses its grounding.
 */
export async function retrieve(env: Env, query: string): Promise<RetrievedChunk[]> {
  // Route through AI Gateway when configured — this gives us per-IP rate
  // limiting + response caching for free, dropping cost for repeated queries.
  const options = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;

  // bge-base-en-v1.5 returns 768-dim vectors in `data[0]`. The model name is
  // an env var so it can be swapped (the Vectorize index dimensions must match).
  const embedded = (await env.AI.run(
    env.EMBED_MODEL as keyof AiModels,
    { text: [query] },
    options
  )) as { data: number[][] };
  const vector = embedded.data[0];
  if (!vector) return [];

  const topK = parseInt(env.TOP_K, 10) || 6;
  const matches = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: "all",
  });

  return matches.matches
    .filter((m) => m.metadata && typeof m.metadata.text === "string")
    .map((m) => {
      const md = m.metadata as Record<string, unknown>;
      return {
        text: String(md.text ?? ""),
        url: String(md.url ?? ""),
        title: String(md.title ?? md.ref ?? ""),
        ref: String(md.ref ?? ""),
        anchor: md.anchor ? String(md.anchor) : undefined,
        score: m.score,
      };
    });
}
