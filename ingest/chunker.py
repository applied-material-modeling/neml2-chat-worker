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

"""Heading-aware markdown chunker.

Splits a markdown document into chunks bounded by ## / ### headings, then
applies a sliding window to any section that exceeds the target token budget.
Each chunk carries its enclosing heading hierarchy (so the embedding has
context) plus the explicit `{#anchor}` if present.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import tiktoken

_ENCODING = tiktoken.get_encoding("cl100k_base")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*(?:\{#([^}]+)\})?\s*$")


@dataclass
class Chunk:
    text: str
    heading: str
    anchor: str | None
    heading_path: list[str]


def _count_tokens(text: str) -> int:
    return len(_ENCODING.encode(text))


def _split_long(
    text: str, heading_path: list[str], heading: str, anchor: str | None,
    target_tokens: int, overlap_tokens: int,
) -> list[Chunk]:
    tokens = _ENCODING.encode(text)
    if len(tokens) <= target_tokens:
        return [Chunk(text=text, heading=heading, anchor=anchor, heading_path=heading_path)]
    chunks: list[Chunk] = []
    step = max(1, target_tokens - overlap_tokens)
    for start in range(0, len(tokens), step):
        window = tokens[start : start + target_tokens]
        if not window:
            break
        chunks.append(
            Chunk(
                text=_ENCODING.decode(window),
                heading=heading,
                anchor=anchor,
                heading_path=heading_path,
            )
        )
        if start + target_tokens >= len(tokens):
            break
    return chunks


def chunk_markdown(
    body: str,
    page_title: str,
    target_tokens: int = 512,
    overlap_tokens: int = 50,
    min_tokens: int = 16,
) -> list[Chunk]:
    """Chunk markdown by ## / ### headings with sliding-window fallback.

    The H1 (page title) becomes the root of every chunk's heading_path; H2/H3
    open new chunks. H4+ stays inside the parent chunk.
    """
    lines = body.splitlines(keepends=True)
    sections: list[tuple[list[str], str, str | None, list[str]]] = []
    current_path = [page_title]
    current_heading = page_title
    current_anchor: str | None = None
    current_lines: list[str] = []

    def flush() -> None:
        text = "".join(current_lines).strip()
        if text:
            sections.append((list(current_path), current_heading, current_anchor, [text]))

    for line in lines:
        m = _HEADING_RE.match(line.rstrip("\n"))
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            anchor = m.group(3)
            if level in (2, 3):
                flush()
                current_lines = []
                current_path = [page_title]
                if level == 3 and len(sections) > 0:
                    last_h2 = next(
                        (s[1] for s in reversed(sections) if len(s[0]) == 2),
                        None,
                    )
                    if last_h2:
                        current_path.append(last_h2)
                current_path.append(title)
                current_heading = title
                current_anchor = anchor
                continue
        current_lines.append(line)

    flush()

    chunks: list[Chunk] = []
    for path, heading, anchor, parts in sections:
        body_text = "\n".join(parts).strip()
        if not body_text:
            continue
        prefixed = f"{' > '.join(path)}\n\n{body_text}"
        if _count_tokens(prefixed) < min_tokens:
            continue
        chunks.extend(
            _split_long(prefixed, path, heading, anchor, target_tokens, overlap_tokens)
        )
    return chunks
