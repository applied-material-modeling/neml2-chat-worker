# Worker bring-up (maintainer-only)

This file walks through the **one-time** Cloudflare provisioning the worker depends on, plus routine deploys. The Vectorize-index refresh procedure (which uses scripts in the neml2 repo) is documented in `doc/chatbot/MAINTAINER.md` of that repo.

You only need §1 once per Cloudflare account. §2 is done routinely (whenever worker code changes).

## 1. Cloudflare provisioning (one-time)

Free Workers plan is sufficient — Vectorize is included (5M stored / 30M queried dimensions/month) and Workers AI gives 10k Neurons/day.

1. **Authorize wrangler on this machine.** No global wrangler install needed; `npm install` puts it in `node_modules/.bin/`. Then authenticate once:
   ```
   npm install
   npx wrangler login
   ```
2. **Account ID** — Cloudflare dashboard → any Workers page → copy the Account ID from the right sidebar. You'll save this as `CLOUDFLARE_ACCOUNT_ID` for the ingest job in the neml2 repo.
3. **Create the Vectorize index**:
   ```
   npx wrangler vectorize create neml2-docs --dimensions=768 --metric=cosine
   ```
4. **Create an API token** at <https://dash.cloudflare.com/profile/api-tokens> → Create Custom Token, with these permissions (Account scope):
   - `Workers Scripts:Edit` — deploy this worker
   - `Vectorize:Edit` — needed by the neml2-side ingest job
   - `Workers AI:Read` — needed by the neml2-side ingest job

   Save the resulting token as `CLOUDFLARE_API_TOKEN` for the ingest. The deploy uses your `wrangler login` credentials separately.
5. **Create an AI Gateway** named `neml2-docs` (dashboard → AI → AI Gateway → Create gateway). The worker is already wired to route both `env.AI.run()` calls through it via the `GATEWAY_ID` var in `wrangler.jsonc`. Benefits: free per-IP rate limiting, response caching for repeated questions, and a request log dashboard. To disable later, remove `GATEWAY_ID` from the vars block.
6. **Enable zone-level Rate Limiting Rules** (free): 10 requests / 10 s / IP for `POST /chat`. This sits in front of the worker's CORS check.

## 2. Deploy the worker

```
npm install                # only after the first clone or after package.json changes
npx wrangler deploy
```

The first deploy prints the public URL (e.g. `https://neml2-chat.<subdomain>.workers.dev`). On the very first deploy, edit `data-endpoint` in the neml2 repo's `doc/content/chatbot.md` to match this URL, then rebuild the docs.

Health check after deploy:
```
curl https://neml2-chat.<subdomain>.workers.dev/healthz
# → {"ok":true,"model":"@cf/meta/..."}

curl -N -X POST https://neml2-chat.<subdomain>.workers.dev/chat \
  -H 'content-type: application/json' \
  -H 'origin: https://applied-material-modeling.github.io' \
  -d '{"messages":[{"role":"user","content":"How do I add a new Model class?"}]}'
# → SSE stream of tokens, then `event: sources`, then `event: done`.
```

A query that returns no tokens is almost always an empty Vectorize index — see the neml2-side `MAINTAINER.md` for the reindex procedure.
