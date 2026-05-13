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

"""Read NEML2's DoxygenLayout.xml and expose a per-ref breadcrumb.

For a navindex like:

    <navindex>
      <tab type="usergroup" title="Guides and Tutorials">
        <tab type="usergroup" url="@ref tutorials-extension" title="Extension">
          <tab type="user" url="@ref tutorials-extension-connection-to-input-files"
               title="Connection to Input Files"/>

`Navindex.breadcrumb("tutorials-extension-connection-to-input-files")` returns
`["Guides and Tutorials", "Extension"]` — the chain of ancestor titles, NOT
including the page's own title (the chunker adds that separately).

Used by `ingest.py` to lift retrieval: prepending these ancestors to every
chunk's heading path lets the embedding and the LLM see the conceptual
category of a page (e.g. "Extension") even when the page-local headings
don't repeat it.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

_REF_PREFIX = "@ref "


class Navindex:
    """Loads `DoxygenLayout.xml` and maps page refs to their ancestor titles."""

    def __init__(self, layout_xml_path: Path | None):
        self._breadcrumbs: dict[str, list[str]] = {}
        if layout_xml_path is None:
            return
        tree = ET.parse(layout_xml_path)
        root = tree.getroot()
        navindex = root.find("navindex")
        if navindex is None:
            return
        self._walk(navindex, ancestors=[])

    def _walk(self, node: ET.Element, ancestors: list[str]) -> None:
        for child in node:
            title = child.get("title")
            url = child.get("url", "") or ""
            if url.startswith(_REF_PREFIX):
                ref = url[len(_REF_PREFIX) :].strip()
                if ref:
                    self._breadcrumbs[ref] = list(ancestors)
            next_ancestors = ancestors + [title] if title else ancestors
            self._walk(child, next_ancestors)

    def breadcrumb(self, ref: str) -> list[str]:
        """Return the chain of ancestor titles for `ref`, or `[]` if unknown."""
        return self._breadcrumbs.get(ref, [])

    def __len__(self) -> int:
        return len(self._breadcrumbs)
