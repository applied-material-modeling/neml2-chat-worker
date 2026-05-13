# tests/fixtures

Tiny, hand-authored inputs for CI smoke tests — kept deliberately small so the
dry-run workflow can run in seconds without cloning neml2 or building its docs.
The real reindex workflow uses an actual neml2 doc build instead; see
`../../.github/workflows/reindex.yml`.

## sample-content/

Mirrors the layout the ingest expects from a real neml2 build: a top-level
directory with a `content/` subdirectory containing preprocessed markdown.

To run the ingest's dry-run against this fixture:

```
./ingest/ingest.py --build-dir tests/fixtures/sample-content --dry-run
```
