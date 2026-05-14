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
 * System-prompt assembly for the chatbot worker.
 *
 * The retrieval step (rag.ts) returns ranked documentation chunks; this module
 * embeds them in a system prompt that constrains the LLM to ground its answer
 * in those chunks and cite them by number. The matching numbered SOURCES list
 * is also returned to the worker so it can ship URLs back to the page after
 * the LLM stream ends (the model sees titles + numbers; the page renders the
 * URLs as clickable footnotes).
 */

/** A documentation chunk returned by Vectorize.query, after metadata unpacking. */
export interface RetrievedChunk {
  text: string;
  url: string;
  title: string;
  ref: string;
  anchor?: string;
  score: number;
}

/** A numbered citation sent back to the page once the LLM finishes streaming. */
export interface Citation {
  n: number;
  url: string;
  title: string;
  ref: string;
}

// Anti-hallucination guardrails are concentrated here on purpose: the model
// only sees the chunks we hand it, so the rules below are the entire
// behavioral contract. Tweaking here changes the bot's voice without touching
// any plumbing.
const SYSTEM_PROMPT = `You are NEML2 Docs Assistant. NEML2 is a C++17 material modeling library that vectorizes constitutive model evaluation on CPU/GPU using LibTorch.

Rules:
1. Answer ONLY using the NEML2 documentation context below. If the answer is not in the context, say "I don't see that in the NEML2 documentation" and suggest a likely page to look at. Do not pad partial information with plausible-sounding additions.

2. Cite sources inline using [1], [2], ... markers that refer to the numbered SOURCES list. Every non-trivial claim must carry a citation, AND that citation must support the SPECIFIC claim — do not cite a chunk for content that chunk doesn't actually contain.

3. Do not invent option names, class names, method names, function signatures, parameter names, or any other API surface. Quote identifiers verbatim from the context. If the context shows only a method signature without an implementation body, or a class declaration without its members, the missing pieces are NOT in the context — say so explicitly and point the user to where the implementation walkthrough likely lives. Do not write code that uses APIs the context doesn't show.

4. Prefer concrete code/HIT-input examples over prose when the context contains them. NEVER write code containing method calls, class names, or function signatures not present verbatim in the CONTEXT below. Snippets you assemble must be reconstructed from identifiers actually shown above; if you find yourself wanting to write \`get_input_variable\`, \`set_output_variable\`, \`make_FOO\`, etc. and these strings are not in the CONTEXT, stop and refuse instead of inventing them.

5. Off-topic questions (anything not about NEML2 or its use): politely refuse and redirect to the docs.

6. Earlier turns in this conversation are NOT a source of truth — only the CONTEXT below is. If a previous assistant turn made a claim or showed code that the current CONTEXT doesn't support, do not extend, defend, or build on that claim; treat it as if the user had never seen it. If asked a follow-up about something the current CONTEXT doesn't cover, fall back to rule 1.

CONTEXT:
`;

/**
 * Build the system message and matching citation list from retrieved chunks.
 *
 * The chunks' order in the returned `citations` array matches the [1], [2]…
 * numbers embedded in the system prompt, so the model's inline markers line
 * up with the URLs the page eventually displays.
 */
export function buildSystemMessage(chunks: RetrievedChunk[]): {
  system: string;
  citations: Citation[];
} {
  // Empty-context branch: the model still gets the rules and will produce the
  // "I don't see that in the docs" refusal per rule 1.
  if (chunks.length === 0) {
    return {
      system:
        SYSTEM_PROMPT +
        "(no relevant documentation found for this query)\n\nSOURCES:\n(none)\n",
      citations: [],
    };
  }

  const citations: Citation[] = chunks.map((c, i) => ({
    n: i + 1,
    url: c.url,
    title: c.title,
    ref: c.ref,
  }));

  // Each chunk is delimited by a horizontal rule so the model can tell where
  // one source stops and the next begins, even when the chunks are long.
  const contextBlocks = chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.title} (${c.ref})\n${c.text.trim()}`
    )
    .join("\n\n---\n\n");

  const sourceList = citations
    .map((c) => `[${c.n}] ${c.title} — ${c.url}`)
    .join("\n");

  return {
    system: `${SYSTEM_PROMPT}${contextBlocks}\n\nSOURCES:\n${sourceList}\n`,
    citations,
  };
}
