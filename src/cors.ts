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
 * CORS allowlist for the chatbot worker.
 *
 * The chat page is hosted on the Doxygen site (GitHub Pages), the worker is
 * hosted on workers.dev — different origins, so every request is cross-origin
 * and triggers a CORS preflight. We accept exact-match origins from the
 * `ALLOWED_ORIGINS` env var (comma-separated) and reject everything else.
 *
 * Note: file:// URLs send `Origin: null`; that string isn't allowlisted, so
 * opening the page from disk fails the preflight. This is intentional — see
 * doc/chatbot/README.md for the local-dev workflow that avoids it.
 */

/** Returns the request's Origin if it matches the allowlist, else null. */
export function allowedOrigin(request: Request, allowList: string): string | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  for (const entry of allowList.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (origin === entry) return origin;
  }
  return null;
}

/**
 * CORS response headers for an allowed origin. Must be applied to every
 * response (including preflight 204s and error JSON), or the browser will
 * reject the response even when the worker returned 200.
 */
export function corsHeaders(origin: string | null): HeadersInit {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
