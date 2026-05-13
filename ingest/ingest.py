#!/usr/bin/env python

# Copyright 2024, UChicago Argonne, LLC
# All Rights Reserved
# Software Name: NEML2 -- the New Engineering material Model Library, version 2
# By: Argonne National Laboratory
# OPEN SOURCE LICENSE (MIT)
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.

"""Ingest preprocessed NEML2 docs into Cloudflare Vectorize.

Reads markdown files under <build-dir>/content (produced by
doc/scripts/genhtml.py), chunks them, embeds via Workers AI, and upserts
to a Vectorize index. Idempotent: stable IDs are sha1(source_path#anchor).

Usage:
  python ingest.py --build-dir build/doc                # full ingest
  python ingest.py --build-dir build/doc --dry-run      # no network calls

Required env vars (skipped under --dry-run):
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
from loguru import logger

from chunker import chunk_markdown
from url_for import page_ref_and_title, url_for

INDEX_NAME = "neml2-docs"
EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"
EMBED_DIMS = 768
CF_API = "https://api.cloudflare.com/client/v4"
STATE_FILENAME = ".chatbot-vector-ids.json"


@dataclass
class Vector:
    id: str
    values: list[float]
    metadata: dict


def stable_id(source_path: str, anchor: str | None, idx: int) -> str:
    h = hashlib.sha1()
    h.update(source_path.encode())
    h.update(b"\n")
    h.update((anchor or "").encode())
    h.update(b"\n")
    h.update(str(idx).encode())
    return h.hexdigest()


def slugify_heading(heading: str) -> str:
    out = []
    for ch in heading.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")


def discover_chunks(build_dir: Path) -> list[Vector]:
    content_dir = build_dir / "content"
    if not content_dir.is_dir():
        logger.error("preprocessed content dir missing: {}", content_dir)
        logger.error("run the neml2 doc build (examples.py + genhtml.py) first")
        sys.exit(2)

    vectors: list[Vector] = []

    for md in sorted(content_dir.rglob("*.md")):
        rel = md.relative_to(content_dir).as_posix()
        ref, title = page_ref_and_title(md)
        if ref is None:
            logger.debug("skip (no ref): {}", rel)
            continue
        with open(md, "r") as f:
            body = f.read()
        chunks = chunk_markdown(body, title)
        if not chunks:
            logger.debug("skip (no chunks): {}", rel)
            continue
        for i, chunk in enumerate(chunks):
            anchor = chunk.anchor or (slugify_heading(chunk.heading) if chunk.heading != title else None)
            page_url = url_for(ref, anchor=anchor)
            vid = stable_id(rel, anchor, i)
            vectors.append(
                Vector(
                    id=vid,
                    values=[],  # filled in by embed_all()
                    metadata={
                        "text": chunk.text,
                        "ref": ref,
                        "title": title,
                        "anchor": anchor or "",
                        "url": page_url,
                        "source_path": rel,
                        "heading": chunk.heading,
                        "heading_path": " > ".join(chunk.heading_path),
                    },
                )
            )
    return vectors


def embed_batch(client: httpx.Client, account_id: str, token: str, texts: list[str]) -> list[list[float]]:
    url = f"{CF_API}/accounts/{account_id}/ai/run/{EMBED_MODEL}"
    resp = client.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"text": texts},
        timeout=60.0,
    )
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("success"):
        raise RuntimeError(f"embedding failed: {payload}")
    data = payload["result"]["data"]
    if len(data) != len(texts):
        raise RuntimeError(
            f"embedding count mismatch: requested {len(texts)}, got {len(data)}"
        )
    return data


def embed_all(
    vectors: list[Vector], account_id: str, token: str, batch_size: int
) -> None:
    with httpx.Client() as client:
        for start in range(0, len(vectors), batch_size):
            batch = vectors[start : start + batch_size]
            texts = [v.metadata["text"] for v in batch]
            logger.info("embedding batch {}/{}",
                        start // batch_size + 1,
                        (len(vectors) + batch_size - 1) // batch_size)
            embeddings = embed_batch(client, account_id, token, texts)
            for v, emb in zip(batch, embeddings):
                if len(emb) != EMBED_DIMS:
                    raise RuntimeError(f"unexpected embedding dim: {len(emb)}")
                v.values = emb


def upsert_vectors(
    vectors: list[Vector], account_id: str, token: str, batch_size: int
) -> None:
    url = f"{CF_API}/accounts/{account_id}/vectorize/v2/indexes/{INDEX_NAME}/upsert"
    with httpx.Client() as client:
        for start in range(0, len(vectors), batch_size):
            batch = vectors[start : start + batch_size]
            ndjson = "\n".join(
                json.dumps({"id": v.id, "values": v.values, "metadata": v.metadata})
                for v in batch
            )
            logger.info("upserting batch {}/{}",
                        start // batch_size + 1,
                        (len(vectors) + batch_size - 1) // batch_size)
            resp = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/x-ndjson",
                },
                content=ndjson.encode(),
                timeout=120.0,
            )
            resp.raise_for_status()
            payload = resp.json()
            if not payload.get("success"):
                raise RuntimeError(f"upsert failed: {payload}")


def delete_stale(
    stale_ids: list[str], account_id: str, token: str
) -> None:
    if not stale_ids:
        return
    url = f"{CF_API}/accounts/{account_id}/vectorize/v2/indexes/{INDEX_NAME}/delete-by-ids"
    logger.info("deleting {} stale vector(s)", len(stale_ids))
    with httpx.Client() as client:
        for start in range(0, len(stale_ids), 1000):
            batch = stale_ids[start : start + 1000]
            resp = client.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json={"ids": batch},
                timeout=60.0,
            )
            resp.raise_for_status()
            payload = resp.json()
            if not payload.get("success"):
                raise RuntimeError(f"delete failed: {payload}")


def load_state(state_path: Path) -> set[str]:
    if not state_path.exists():
        return set()
    try:
        return set(json.loads(state_path.read_text())["ids"])
    except Exception:
        logger.warning("could not parse state file; starting fresh")
        return set()


def write_state(state_path: Path, ids: set[str]) -> None:
    state_path.write_text(json.dumps({"ids": sorted(ids), "updated": time.time()}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", required=True,
                        help="path to a neml2 doc build (must contain content/ "
                             "produced by doc/scripts/genhtml.py)")
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--dry-run", action="store_true",
                        help="chunk + report without embedding/upserting")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logger.remove()
    logger.add(sys.stderr, level=args.log_level.upper())

    build_dir = Path(args.build_dir).resolve()

    vectors = discover_chunks(build_dir)
    logger.info("discovered {} chunk(s) across {} pages",
                len(vectors),
                len({v.metadata["source_path"] for v in vectors}))

    if args.dry_run:
        for v in vectors[:5]:
            logger.info("sample: {} → {}", v.metadata["heading_path"], v.metadata["url"])
            logger.debug("  text[:200]: {}", v.metadata["text"][:200])
        logger.info("dry run; exiting")
        return

    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not account_id or not token:
        logger.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set")
        sys.exit(2)

    embed_all(vectors, account_id, token, args.batch_size)
    upsert_vectors(vectors, account_id, token, args.batch_size)

    state_path = build_dir / STATE_FILENAME
    prior = load_state(state_path)
    current = {v.id for v in vectors}
    stale = sorted(prior - current)
    delete_stale(stale, account_id, token)
    write_state(state_path, current)

    logger.success("ingest complete: {} upserted, {} pruned", len(current), len(stale))


if __name__ == "__main__":
    main()
