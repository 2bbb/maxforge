#!/usr/bin/env python3

from __future__ import annotations

import argparse
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse


class SiteParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.references: list[str] = []
        self.title_depth = 0
        self.title = ""

    def handle_starttag(
        self,
        tag: str,
        attributes: list[tuple[str, str | None]],
    ) -> None:
        attribute_map = dict(attributes)
        element_id = attribute_map.get("id")
        if element_id:
            self.ids.add(element_id)

        if tag == "a" and attribute_map.get("href"):
            self.references.append(attribute_map["href"] or "")
        if tag == "link" and attribute_map.get("href"):
            self.references.append(attribute_map["href"] or "")
        if tag == "script" and attribute_map.get("src"):
            self.references.append(attribute_map["src"] or "")
        if tag == "title":
            self.title_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.title_depth -= 1

    def handle_data(self, data: str) -> None:
        if 0 < self.title_depth:
            self.title += data


def verify_site(site_directory: Path) -> list[str]:
    errors: list[str] = []
    index_path = site_directory / "index.html"
    if not index_path.is_file():
        return [f"missing entry page: {index_path}"]

    parser = SiteParser()
    html = index_path.read_text(encoding="utf-8")
    parser.feed(html)

    if not parser.title.strip():
        errors.append("index.html has no title")
    if "Not affiliated with" not in html:
        errors.append("index.html is missing the unofficial-project disclaimer")
    if "npx maxforge@latest" not in html:
        errors.append("index.html is missing the npx quickstart")

    for reference in parser.references:
        parsed = urlparse(reference)
        if parsed.scheme or parsed.netloc or reference.startswith("mailto:"):
            continue
        if reference.startswith("#"):
            target = reference[1:]
            if target and target not in parser.ids:
                errors.append(f"missing local anchor: {reference}")
            continue

        relative_path = parsed.path
        if not relative_path:
            continue
        asset_path = site_directory / relative_path
        if not asset_path.is_file():
            errors.append(f"missing local asset: {reference}")

    for required_name in [".nojekyll", "styles.css", "main.js", "favicon.svg"]:
        required_path = site_directory / required_name
        if not required_path.is_file():
            errors.append(f"missing required site file: {required_name}")

    return errors


def main() -> int:
    argument_parser = argparse.ArgumentParser(
        description="Validate the static maxforge GitHub Pages site"
    )
    argument_parser.add_argument(
        "site_directory",
        nargs="?",
        default="site",
        type=Path,
    )
    arguments = argument_parser.parse_args()
    errors = verify_site(arguments.site_directory)

    if errors:
        for error in errors:
            print(f"error: {error}")
        return 1

    print(f"GitHub Pages site is valid: {arguments.site_directory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
