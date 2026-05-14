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
 * NEML2 docs chatbot worker — entrypoint.
 *
 * Routes:
 *   POST /chat     — RAG + streaming LLM response (SSE).
 *   OPTIONS /chat  — CORS preflight.
 *   GET /healthz   — liveness probe; returns the configured model name.
 *
 * Wire format on POST /chat — server-sent events with two channels:
 *   `data: {"type":"token","text":"..."}`  per LLM token (no `event:` line).
 *   `event: sources\ndata: {"sources":[...]}`  one final list of citations.
 *   `event: done\ndata: {}`  terminator.
 *   `event: error\ndata: {"message":"..."}`  on stream failure.
 *
 * The page (doc/chatbot/page/chat.js) consumes those events with `fetch` +
 * `response.body.getReader()`. Citation URLs are computed at ingest time and
 * round-trip through Vectorize metadata; the worker never invents them.
 */

import { allowedOrigin, corsHeaders } from "./cors.js";
import { retrieve } from "./rag.js";
import { streamCompletion, type ChatMessage } from "./llm.js";
import { buildSystemMessage, type Citation } from "./prompt.js";

interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  MODEL: string;
  EMBED_MODEL: string;
  TOP_K: string;
  MAX_HISTORY: string;
  HYDE: string;
  TEMPERATURE: string;
  GATEWAY_ID?: string;
  ALLOWED_ORIGINS: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
}

/**
 * Validate that the request body is the expected `{ messages: [...] }` shape
 * with at least one message and a trailing `user` turn. Anything else gets a
 * 400 — we don't try to be helpful about partial bodies because the page is
 * the only known client.
 */
function isChatRequestBody(value: unknown): value is ChatRequestBody {
  if (!value || typeof value !== "object") return false;
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const m of messages) {
    if (!m || typeof m !== "object") return false;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant" && role !== "system") return false;
    if (typeof content !== "string") return false;
  }
  if ((messages[messages.length - 1] as ChatMessage).role !== "user") return false;
  return true;
}

// SSE responses must NOT be buffered or transformed by intermediaries; these
// headers (especially `X-Accel-Buffering: no`) make sure proxies that respect
// them flush each chunk immediately. Without that, tokens batch into a single
// burst at the end and the streaming UX disappears.
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
};

/**
 * Encode one SSE event. SSE wire grammar: optional `event:` line, then one or
 * more `data:` lines, then a blank line that terminates the event. We always
 * use a single JSON `data:` line and a `\n\n` terminator.
 */
function sseEvent(event: string | null, data: unknown): Uint8Array {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push("", "");
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * The /chat handler. Embeds the user query, retrieves chunks, builds a
 * grounded system prompt, then bridges the upstream Workers AI SSE stream
 * into our own SSE format — re-emitting each token as a `{type:"token"}`
 * event and appending citations + a `done` terminator at the end.
 */
async function handleChat(request: Request, env: Env, origin: string): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, "invalid_json", origin);
  }
  if (!isChatRequestBody(body)) {
    return jsonError(400, "bad_request", origin);
  }

  // Cap history to MAX_HISTORY trailing turns so prompt size + token cost
  // stay bounded even if the page sends a very long conversation.
  const maxHistory = parseInt(env.MAX_HISTORY, 10) || 8;
  const trimmed = body.messages.slice(-maxHistory);
  const lastUser = trimmed[trimmed.length - 1].content.trim();
  if (!lastUser) return jsonError(400, "empty_query", origin);

  // Pass the full trimmed history (not just lastUser): retrieve()'s HyDE
  // step is history-aware and will resolve follow-up references like "how
  // about its arguments?" against earlier turns before drafting the
  // hypothetical that anchors the embedding.
  const chunks = await retrieve(env, trimmed);
  const { system, citations } = buildSystemMessage(chunks);

  // The system message is rebuilt fresh for every turn — older turns in the
  // history shouldn't carry stale retrieved context.
  const llmMessages: ChatMessage[] = [
    { role: "system", content: system },
    ...trimmed,
  ];

  const upstream = await streamCompletion(env, llmMessages);

  // Bridge upstream SSE -> our SSE. The upstream byte stream isn't aligned
  // to event boundaries (chunks can split mid-line), so we accumulate into
  // `buffer` and flush complete `\n`-terminated lines.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // Last element may be a partial line; keep it for the next chunk.
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const tok = parseUpstreamLine(line);
            if (tok !== null) controller.enqueue(sseEvent(null, { type: "token", text: tok }));
          }
        }
        // Flush any trailing partial line (rare; only when upstream omits the
        // final newline before [DONE]).
        if (buffer.length > 0) {
          const tok = parseUpstreamLine(buffer);
          if (tok !== null) controller.enqueue(sseEvent(null, { type: "token", text: tok }));
        }
        controller.enqueue(sseEvent("sources", { sources: citations }));
        controller.enqueue(sseEvent("done", {}));
      } catch (err) {
        controller.enqueue(
          sseEvent("error", { message: err instanceof Error ? err.message : "stream_error" })
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { ...SSE_HEADERS, ...corsHeaders(origin) },
  });
}

/**
 * Parse one upstream SSE line into a token string, or null if the line is
 * non-content (blank line, [DONE] marker, or malformed). Workers AI follows
 * OpenAI's convention: `data: {"response":"...token text..."}`.
 *
 * `response` is *almost* always a string, but for single-character numeric
 * tokens we've observed the upstream JSON-encode it as a number (e.g.
 * `{"response":1}`). Coerce to string so digit-only citation markers like
 * `[1]` don't lose their digit and render as `[]` on the page.
 */
function parseUpstreamLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice("data:".length).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload) as { response?: unknown };
    const r = obj.response;
    if (r === null || r === undefined) return null;
    if (typeof r === "string") return r.length > 0 ? r : null;
    if (typeof r === "number" || typeof r === "boolean") return String(r);
    return null;
  } catch {
    return null;
  }
}

/** JSON error response with CORS headers attached. */
function jsonError(status: number, code: string, origin: string | null): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request, env.ALLOWED_ORIGINS);
    const url = new URL(request.url);

    // CORS preflight: 204 with the standard allow-* headers, or 403 if the
    // calling origin isn't in the allowlist (browsers will then refuse the
    // real request without sending it).
    if (request.method === "OPTIONS") {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Liveness probe — intentionally allowed regardless of origin so monitors
    // can hit it without a CORS configured.
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response(JSON.stringify({ ok: true, model: env.MODEL }), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      if (!origin) return jsonError(403, "origin_not_allowed", null);
      return handleChat(request, env, origin);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(origin) });
  },
} satisfies ExportedHandler<Env>;

// Re-export for tests.
export type { Citation };
