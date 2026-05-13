# ingest

Indexer for the NEML2 docs chatbot. Reads the preprocessed markdown produced by neml2's `doc/scripts/genhtml.py`, chunks it, embeds via Cloudflare Workers AI (`@cf/baai/bge-base-en-v1.5`), and upserts to the `neml2-docs` Vectorize index that the worker queries at runtime.

For the routine refresh procedure (with credentials and a built neml2 doc tree), see [`../BRING-UP.md`](../BRING-UP.md#3-refresh-the-vectorize-index).

For a no-network sanity check on chunking behavior, against an existing built neml2 doc tree:

```
pip install -r ingest/requirements.txt
./ingest/ingest.py --build-dir /path/to/neml2/build/doc --dry-run
```

`--build-dir` is required and points at the neml2 doc-build root (the directory that contains `content/` after `genhtml.py` ran).

## Implementation

- **Idempotency.** Stable IDs are `sha1(source_path#anchor#chunk_idx)`. State of which IDs were last upserted is stored in `<build-dir>/.chatbot-vector-ids.json`; on re-ingest, any vector whose ID is no longer produced gets deleted from Vectorize.
- **Chunking** lives in `chunker.py`. Target is ~512 tokens per chunk with a 50-token sliding-window overlap on long sections; the page title is prepended to every chunk so the embedding has page context.
- **URL mapping.** `url_for.py` extracts the `ref` from the first heading's `{#ref}` anchor and builds `<base>/<ref>.html[#<sub-anchor>]`. The neml2 preprocess pipeline guarantees every preprocessed page begins with `# Title {#ref}`. If a Doxygen slug convention change ever breaks this, fix it here.
- **Batching.** `--batch-size N` controls both the embedding-call batch size and the Vectorize upsert batch size. Default 50 balances Workers AI throughput against per-call neuron cost.

See [`../README.md`](../README.md) for the broader chatbot architecture.
