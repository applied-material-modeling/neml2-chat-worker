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
 * Streaming LLM call wrapper.
 *
 * `env.AI.run(model, { ..., stream: true })` returns a `ReadableStream` of
 * server-sent-event bytes (`data: {"response":"..."}\n\n` per chunk, then
 * `data: [DONE]\n\n`). The worker does not consume that stream here — it
 * pipes the raw bytes through its own SSE transformer in index.ts so the
 * page sees a steady token feed. Keeping this thin lets us swap the LLM
 * provider later without touching the streaming machinery.
 */

interface Env {
  AI: Ai;
  MODEL: string;
  GATEWAY_ID?: string;
}

/** OpenAI-style chat message; the only shape Workers AI's chat models accept. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Kick off a streaming completion. The returned stream is the upstream
 * Workers AI SSE byte stream; index.ts re-emits its tokens as the worker's
 * own SSE wire format.
 */
export async function streamCompletion(
  env: Env,
  messages: ChatMessage[]
): Promise<ReadableStream<Uint8Array>> {
  // GATEWAY_ID, when set, routes the call through AI Gateway for caching +
  // observability. Without it the call goes straight to Workers AI.
  const options = env.GATEWAY_ID ? { gateway: { id: env.GATEWAY_ID } } : undefined;
  const result = await env.AI.run(
    env.MODEL as keyof AiModels,
    { messages, stream: true, max_tokens: 1024 },
    options
  );
  return result as ReadableStream<Uint8Array>;
}
