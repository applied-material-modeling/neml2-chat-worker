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

"""Map a preprocessed-markdown source path to the deployed Doxygen URL.

Doxygen's HTML output filename for a Markdown page is `<ref>.html`, where
`<ref>` is the anchor declared on the page's first heading: `# Title {#ref}`.
The neml2 doc-build pipeline (doc/scripts/genhtml.py + preprocess.py)
guarantees that every preprocessed page starts with such a heading — the
`@insert-title:<ref>` directive is expanded upstream — so we only need to
extract the anchor here.
"""

from __future__ import annotations

import re
from pathlib import Path

DEPLOYED_BASE = "https://applied-material-modeling.github.io/neml2"

_HEADING_REF_RE = re.compile(r"^#\s+(.*?)\s*(?:\{#([^}]+)\})?\s*$")


def page_ref_and_title(md_path: Path) -> tuple[str | None, str]:
    """Return (ref, title) for a preprocessed markdown file.

    Returns (None, fallback_title) when the file's first non-empty line is
    not an H1 heading or the heading lacks a `{#ref}` anchor. Such pages are
    rare and usually not user-facing; the caller should skip them.
    """
    first_line = ""
    with open(md_path, "r") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                first_line = stripped
                break
    if not first_line:
        return None, md_path.stem

    m = _HEADING_REF_RE.match(first_line)
    if not m:
        return None, md_path.stem
    title = m.group(1).strip()
    ref = m.group(2)
    return ref, title or md_path.stem


def url_for(ref: str, anchor: str | None = None) -> str:
    base = f"{DEPLOYED_BASE}/{ref}.html"
    if anchor:
        return f"{base}#{anchor}"
    return base
