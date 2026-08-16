#!/usr/bin/env python3

"""Verify that repository-local Markdown link targets exist."""

from __future__ import annotations

import re
import shlex
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_ROOTS = (
    ROOT / "README.md",
    ROOT / "docs",
    ROOT / "examples",
    ROOT / "skills",
    ROOT / "working-docs",
)
LINK_PATTERN = re.compile(r"!?(?:\[[^]]*\])\(([^)]+)\)")


def markdown_files() -> list[Path]:
    files: list[Path] = []
    for root in MARKDOWN_ROOTS:
        if root.is_file():
            files.append(root)
        elif root.is_dir():
            files.extend(root.rglob("*.md"))
    return sorted(files)


def link_destination(raw: str) -> str:
    value = raw.strip()
    if value.startswith("<") and ">" in value:
        return value[1:value.index(">")]
    try:
        parts = shlex.split(value)
    except ValueError:
        return value
    return parts[0] if parts else ""


def main() -> int:
    errors: list[str] = []
    files = markdown_files()
    for source in files:
        for raw in LINK_PATTERN.findall(source.read_text(encoding="utf-8")):
            destination = link_destination(raw)
            parsed = urlparse(destination)
            if parsed.scheme or destination.startswith(("#", "//")):
                continue
            local_path = unquote(destination.split("#", 1)[0])
            if not local_path:
                continue
            target = (source.parent / local_path).resolve()
            if not target.exists():
                errors.append(
                    f"{source.relative_to(ROOT)}: missing link target {destination}"
                )

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Markdown links are valid: {len(files)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
