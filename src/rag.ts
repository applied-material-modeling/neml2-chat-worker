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
 * Retrieval step of the RAG pipeline, with HyDE-style query expansion.
 *
 * Pipeline:
 *   1. Generate a brief hypothetical answer to the user's question (HyDE).
 *   2. Embed the query + hypothetical concatenation.
 *   3. Query Vectorize for top-K most similar chunks.
 *   4. Unpack each match's metadata for the prompt builder.
 *
 * Why HyDE: bge-base-en-v1.5 is dominated by surface lexical overlap.
 * "How do I create a new Model class" matches loading/composing chunks (which
 * repeat the word "Model" often) over the actual extension tutorials (whose
 * vocabulary is "argument declaration", "forward operator", "subclass",
 * "register_NEML2_object"). A 2-3 sentence hypothetical answer from the LLM
 * usually pulls in those domain-specific terms and lets retrieval snap to the
 * right pages. Concatenating the raw query keeps lexical anchors so a bad
 * hypothetical can't drag retrieval entirely off-topic.
 *
 * The Vectorize index must be populated by the ingest job before this returns
 * anything useful — an empty index means an empty result set, and the prompt
 * builder will hand the model the "no context" branch.
 */

import type { RetrievedChunk } from "./prompt.js";

interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  MODEL: string;
  EMBED_MODEL: string;
  TOP_K: string;
  HYDE: string;
  GATEWAY_ID?: string;
}

const HYDE_SYSTEM_PROMPT = `You are a NEML2 documentation expert. Given a user question, draft a brief (2-3 sentences max) plausible answer using terminology that would actually appear in the NEML2 docs (specific class names like \`Model\`, method names like \`set_value\`, macros like \`register_NEML2_object\`, file types like input file). Do not hedge, do not refuse, do not include disclaimers — this draft is only used to improve document retrieval and is not shown to the user. If you don't know specifics, use plausible-sounding NEML2 vocabulary.`;

async function hydeExpand(env: Env, query: string): Promise<string> {
  const options = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;
  try {
    const result = (await env.AI.run(
      env.MODEL as keyof AiModels,
      {
        messages: [
          { role: "system", content: HYDE_SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
        max_tokens: 200,
        temperature: 0.2,
      },
      options
    )) as { response?: string };
    return typeof result.response === "string" ? result.response.trim() : "";
  } catch {
    // Don't fail the whole request if HyDE expansion errors — fall back to the
    // raw query. Worst case: same retrieval quality as before HyDE.
    return "";
  }
}

export async function retrieve(env: Env, query: string): Promise<RetrievedChunk[]> {
  // Route AI calls through AI Gateway when configured (caching + per-IP rate
  // limiting + observability).
  const options = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;

  const useHyde = env.HYDE === "true" || env.HYDE === "1";
  const hypothetical = useHyde ? await hydeExpand(env, query) : "";
  const embedInput = hypothetical ? `${query}\n\n${hypothetical}` : query;

  // bge-base-en-v1.5 returns 768-dim vectors in `data[0]`. The model name is
  // an env var so it can be swapped (the Vectorize index dimensions must match).
  const embedded = (await env.AI.run(
    env.EMBED_MODEL as keyof AiModels,
    { text: [embedInput] },
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
