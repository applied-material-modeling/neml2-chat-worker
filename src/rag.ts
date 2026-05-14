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
 * Retrieval step of the RAG pipeline, with history-aware HyDE.
 *
 * Pipeline:
 *   1. Generate a brief hypothetical answer (HyDE) using the FULL recent
 *      chat history as context. The hypothetical resolves follow-up
 *      references like "how do I declare its arguments?" against earlier
 *      turns, producing NEML2 vocabulary that matches the right docs.
 *   2. Embed the (latest user message) + hypothetical concatenation. The
 *      latest message is kept as a lexical anchor; the hypothetical adds
 *      domain vocabulary and resolved references.
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
 * Why history-aware HyDE (no separate query rewrite): a single LLM call
 * does both jobs — it sees the conversation and produces a context-aware
 * hypothetical that has already resolved any references. Same cost as
 * single-turn HyDE; no extra LLM round-trip vs the standard rewrite +
 * HyDE two-step.
 *
 * The Vectorize index must be populated by the ingest job before this returns
 * anything useful — an empty index means an empty result set, and the prompt
 * builder will hand the model the "no context" branch.
 */

import type { RetrievedChunk } from "./prompt.js";
import type { ChatMessage } from "./llm.js";

interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  MODEL: string;
  EMBED_MODEL: string;
  TOP_K: string;
  HYDE: string;
  GATEWAY_ID?: string;
}

/**
 * Sentinel the HyDE prompt uses to mark a query as out of NEML2's scope.
 * Picked to be unlikely to appear in any legitimate NEML2 hypothetical so
 * that startsWith() detection has no false positives.
 */
const OFFTOPIC_MARKER = "OFFTOPIC";

const HYDE_SYSTEM_PROMPT = `You are a NEML2 documentation expert. NEML2 is a C++17 material modeling library that vectorizes constitutive model evaluation on CPU/GPU using LibTorch.

You will be shown the recent conversation history (which may be just one turn). Focus on the user's latest message, but resolve any references to earlier turns ("the previous one", "how about its arguments?", "in Python?", "what other options does it have?") against that prior context. The hypothetical you draft below should answer the resolved question, not the literal latest message.

If the conversation is clearly outside NEML2's scope — general knowledge ("what's the weather"), small talk ("tell me a joke"), unrelated software (PyTorch installation help, Excel formulas), or anything that has nothing to do with material modeling, NEML2's API, building/installing NEML2, or NEML2 input files — respond with exactly the literal string ${OFFTOPIC_MARKER} and nothing else. Apply this to the conversation as a whole: a NEML2 follow-up after a NEML2 question is on-topic even if the follow-up alone reads ambiguously.

Otherwise, draft a brief (2-3 sentences max) plausible answer using terminology that would actually appear in the NEML2 docs (specific class names like \`Model\`, method names like \`set_value\`, macros like \`register_NEML2_object\`, file types like input file). Do not hedge, do not refuse, do not include disclaimers — this draft is only used to improve document retrieval and is not shown to the user. If you don't know specifics, use plausible-sounding NEML2 vocabulary.

Bias toward expanding rather than refusing: only mark ${OFFTOPIC_MARKER} when the conversation is unmistakably outside NEML2's domain. The downstream answer LLM will catch borderline cases.`;

interface HydeResult {
  hypothetical: string;
  offtopic: boolean;
}

async function hydeExpand(env: Env, history: ChatMessage[]): Promise<HydeResult> {
  const options = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;
  try {
    const result = (await env.AI.run(
      env.MODEL as keyof AiModels,
      {
        messages: [{ role: "system", content: HYDE_SYSTEM_PROMPT }, ...history],
        max_tokens: 200,
        temperature: 0.2,
      },
      options
    )) as { response?: string };
    const text = typeof result.response === "string" ? result.response.trim() : "";
    if (text.startsWith(OFFTOPIC_MARKER)) {
      return { hypothetical: "", offtopic: true };
    }
    return { hypothetical: text, offtopic: false };
  } catch {
    // Don't fail the whole request if HyDE expansion errors — fall back to the
    // raw query. Worst case: same retrieval quality as before HyDE.
    return { hypothetical: "", offtopic: false };
  }
}

export async function retrieve(env: Env, history: ChatMessage[]): Promise<RetrievedChunk[]> {
  // Route AI calls through AI Gateway when configured (caching + per-IP rate
  // limiting + observability).
  const options = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;

  // The latest user message is the lexical anchor for the embedding. Even
  // with a context-aware hypothetical, keeping the user's literal phrasing
  // in the embed input limits how badly a bad hypothetical can drag
  // retrieval off-topic.
  const lastUser = history[history.length - 1]?.content?.trim() ?? "";
  if (!lastUser) return [];

  const useHyde = env.HYDE === "true" || env.HYDE === "1";
  if (useHyde) {
    const hyde = await hydeExpand(env, history);
    if (hyde.offtopic) {
      // Skip embed + Vectorize entirely. Empty results route into the
      // "no relevant documentation" branch in prompt.ts, and the answer LLM
      // refuses politely per its rule 1 / rule 5.
      return [];
    }
    const embedInput = hyde.hypothetical ? `${lastUser}\n\n${hyde.hypothetical}` : lastUser;
    return await embedAndQuery(env, embedInput, options);
  }
  return await embedAndQuery(env, lastUser, options);
}

async function embedAndQuery(
  env: Env,
  embedInput: string,
  options: { gateway: { id: string } } | undefined
): Promise<RetrievedChunk[]> {
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
