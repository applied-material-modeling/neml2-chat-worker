# Bring-up (maintainer-only)

A one-time setup of the Cloudflare resources the chatbot depends on, plus the GitHub Actions secrets that let CI deploy and reindex on its own. After this, no maintainer ever runs `wrangler deploy` or the ingest from a laptop — everything goes through the workflows in `.github/workflows/`.

## 1. Provision the Cloudflare resources

### Vectorize index

```
npx wrangler login    # one-time browser OAuth; NOT the API token below
npx wrangler vectorize create neml2-docs --dimensions=768 --metric=cosine
```

`wrangler login` opens a browser to authorize this machine for *your own* dashboard actions. The OAuth token wrangler caches under `~/.config/.wrangler/` is scoped to your user and is *not* the credential CI uses — that is a separate API token (§2).

### AI Gateway

Dashboard → **AI** → **AI Gateway** → **Create gateway**. The worker is wired to route both `env.AI.run()` calls through a gateway whose name matches `GATEWAY_ID` in `wrangler.jsonc`. Two valid options:
- **Use the wired-in name** — create the gateway as `neml2-docs` and you're done.
- **Use a different name** — create it under whatever name you want, then change `GATEWAY_ID` in `wrangler.jsonc` and merge before the next CI deploy.

To skip the gateway entirely, remove the `GATEWAY_ID` line from the `vars` block and the worker will call Workers AI directly. Benefits of keeping it: free per-IP rate limiting, response caching for repeated questions, and a request-log dashboard.

### Rate Limiting Rules (recommended)

Dashboard → **Security** → **Rate Limiting Rules** → 10 requests / 10 s / IP for `POST /chat` on the deployed worker hostname. Sits in front of the worker's CORS check.

## 2. Configure CI secrets

Mint a Cloudflare API token at <https://dash.cloudflare.com/profile/api-tokens> → **Create Custom Token**, with these permissions (all at Account scope):

- `Workers Scripts:Edit` — needed by `deploy.yml`
- `Vectorize:Edit` — needed by `reindex.yml`
- `Workers AI:Read` — needed by `reindex.yml`

Add it to this repo's GitHub secrets (**Settings → Secrets and variables → Actions → New repository secret**):

- `CLOUDFLARE_API_TOKEN` — the token you just minted.
- `CLOUDFLARE_ACCOUNT_ID` — from any Workers page in the Cloudflare dashboard (right sidebar).

These are the **only** places either value should live. Do not export them in your shell, do not put them in a `.env` file, do not commit them anywhere.

## 3. First deploy + first reindex

Once §1 and §2 are done, kick off the workflows manually from the **Actions** tab (later runs trigger themselves on schedule and on push):

1. **Actions → Deploy worker → Run workflow** (branch `main`). Watch it complete; the run logs print the deployed URL on the line `Published neml2-chat (...) to https://neml2-chat.<subdomain>.workers.dev`. If this is the very first deploy, edit `data-endpoint` in the neml2 repo's `doc/content/chatbot.md` to match this URL and rebuild the docs.
2. **Actions → Reindex Vectorize → Run workflow** (branch `main`). The first run takes ~25 min because it clones neml2, installs C++/Python deps, builds the docs, and embeds every chunk. Subsequent runs are similar but incremental against Vectorize.
3. Health-check from any browser:
   `https://neml2-chat.<subdomain>.workers.dev/healthz` → `{"ok":true,"model":"@cf/meta/..."}`.

## Rotating or migrating secrets

If you ever need to rotate the API token (compromise, expiry) or move to a different Cloudflare account:

1. Mint a new token with the same three permissions in the target account.
2. Update `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID` if changing accounts) in this repo's Actions secrets.
3. If switching accounts, also recreate the Vectorize index and AI Gateway under the new account (per §1), and re-run §3.
4. Manually trigger `deploy.yml` and `reindex.yml` to confirm the new credentials work.
5. Revoke the old token in the previous account's dashboard.

Nothing else changes — there's no checked-in or local copy of the secret to chase down.
