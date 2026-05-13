# neml2-chat-worker

Cloudflare Worker that powers the "Ask AI" page on the [NEML2 documentation site](https://applied-material-modeling.github.io/neml2). It performs retrieval against a Vectorize index of NEML2's docs and streams an LLM response back via SSE.

```
chatbot.html (in the neml2 repo's docs)
    │   chat.js mounts a messenger UI inside #neml2-chatbot-root
    ▼
THIS WORKER  ─►  Vectorize    (top-k retrieval, 768-dim cosine; populated by neml2's ingest)
            └─►  Workers AI   (embed query + stream LLM tokens, optionally via AI Gateway)
```

The browser UI (`chat.js`/`chat.css`) and the index population step (`ingest/`) live in the [neml2 repo](https://github.com/applied-material-modeling/neml2) under `doc/chatbot/` — they're tied to NEML2's documentation structure. This repo is the part that runs on Cloudflare and is owned by the NEML2 maintainers.

For first-time setup of the Cloudflare account, Vectorize index, API tokens, AI Gateway, and the initial deploy, see [BRING-UP.md](BRING-UP.md).

## Integration contract with the neml2 repo

The worker depends on three shared assumptions that must hold across both repos. Any change to these requires coordinated PRs.

**Embedding model + dimensions.** The query embedding here MUST match the chunk embeddings written by the neml2 ingest job:
- Model: `@cf/baai/bge-base-en-v1.5`
- Dimensions: 768 (Vectorize index created with `--dimensions=768 --metric=cosine`)

Set in `wrangler.jsonc` (`EMBED_MODEL`) and in neml2's `doc/chatbot/ingest/ingest.py` (`EMBED_MODEL`, `EMBED_DIMS`).

**Vectorize record metadata.** The worker reads these keys from each match's metadata; the neml2 ingest writes them:
- `text` — the chunk's raw text (string).
- `url` — fully-qualified citation URL (string).
- `title` — page title (string, used in the prompt and citation footer).
- `ref` — Doxygen page ref slug (string).
- `anchor` — sub-heading anchor (string, may be empty).

Renaming any of these silently empties the model's context. The Vectorize index name is `neml2-docs` on both sides.

**Wire format on `POST /chat`** (browser ↔ worker, served as SSE):
- One `data: {"type":"token","text":"..."}` event per LLM token.
- Then `event: sources\ndata: {"sources":[{n,url,title,ref}, ...]}` once.
- Then `event: done\ndata: {}` as the terminator.
- `event: error\ndata: {"message":"..."}` on stream failure.

The page's `chat.js` consumes this; changing the format here breaks the page. The CORS allowlist (`ALLOWED_ORIGINS` in `wrangler.jsonc`) must include the deployed doc origin (`https://applied-material-modeling.github.io`) and any local-dev origin contributors will use.

## Working on the worker

```
npm install                       # only needed the first time
npx wrangler dev --remote         # serves http://localhost:8787
```

`--remote` is required: `env.AI` and `env.VECTORIZE` aren't usable in pure-local mode (no local AI/Vectorize emulation). Code changes hot-reload immediately, but the bindings hit the real Cloudflare resources you provisioned per BRING-UP.

Smoke tests against the local instance:

```
curl http://localhost:8787/healthz
curl -N -X POST http://localhost:8787/chat \
  -H 'content-type: application/json' \
  -H 'origin: http://localhost:8000' \
  -d '{"messages":[{"role":"user","content":"How do I add a new Model class?"}]}'
```

### Typecheck

```
./scripts/typecheck.sh            # runs `wrangler types` then `tsc --noEmit`
```

The script regenerates `worker-configuration.d.ts` (gitignored) from `wrangler.jsonc` so binding type changes propagate immediately. Wiring it into a pre-commit hook is left as an operator preference.

## Layout

- `src/index.ts` — entrypoint, routes, SSE bridge.
- `src/rag.ts` — embed + Vectorize query.
- `src/llm.ts` — streaming Workers AI call (LLM model name from `MODEL` env var).
- `src/prompt.ts` — system prompt and citation assembly. Hallucination rules live here.
- `src/cors.ts` — origin allowlist semantics.

## Operating notes

**Cost ceiling.** Workers AI free tier is 10k Neurons/day. Each chat round-trip is roughly 5–15 Neurons (embed + LLM call). AI Gateway caching cuts repeated questions to ~0 cost. Set an alert on the gateway's spend dashboard before opening the bot to wide traffic.

**Hallucination guardrails.** The system prompt in `src/prompt.ts` instructs the model to refuse when the answer isn't in the retrieved context. Test periodically with adversarial prompts ("does NEML2 support relativistic effects?" — should refuse, not bluff).

**Switching LLM provider.** `MODEL` and `EMBED_MODEL` are env vars in `wrangler.jsonc`. To route through Anthropic or OpenAI via AI Gateway, replace the `env.AI.run(MODEL, …)` call in `src/llm.ts` with a `fetch` to the gateway's OpenAI-compat endpoint (`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions`) and add the provider's API key as a Worker secret (`npx wrangler secret put ANTHROPIC_API_KEY`).
