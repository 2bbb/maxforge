#!/usr/bin/env python3

from __future__ import annotations

import argparse
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree


class SiteParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.duplicate_ids: set[str] = set()
        self.references: list[str] = []
        self.title_depth = 0
        self.title = ""
        self.language = ""
        self.heading_one_count = 0

    def handle_starttag(
        self,
        tag: str,
        attributes: list[tuple[str, str | None]],
    ) -> None:
        attribute_map = dict(attributes)
        element_id = attribute_map.get("id")
        if element_id:
            if element_id in self.ids:
                self.duplicate_ids.add(element_id)
            self.ids.add(element_id)

        if tag == "html":
            self.language = attribute_map.get("lang") or ""
        if tag == "h1":
            self.heading_one_count += 1
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


def parse_pages(site_directory: Path) -> dict[Path, SiteParser]:
    pages: dict[Path, SiteParser] = {}
    for page_path in sorted(site_directory.rglob("*.html")):
        parser = SiteParser()
        parser.feed(page_path.read_text(encoding="utf-8"))
        pages[page_path.resolve()] = parser
    return pages


def local_reference_target(
    site_directory: Path,
    source_path: Path,
    reference: str,
) -> tuple[Path | None, str]:
    parsed = urlparse(reference)
    if parsed.scheme or parsed.netloc or reference.startswith(("mailto:", "tel:")):
        return None, ""

    reference_path = unquote(parsed.path)
    if reference_path.startswith("/"):
        target_path = site_directory / reference_path.lstrip("/")
    elif reference_path:
        target_path = source_path.parent / reference_path
    else:
        target_path = source_path

    target_path = target_path.resolve()
    if target_path.is_dir() or reference_path.endswith("/"):
        target_path /= "index.html"
    return target_path, unquote(parsed.fragment)


def verify_page_references(
    site_directory: Path,
    pages: dict[Path, SiteParser],
) -> list[str]:
    errors: list[str] = []
    resolved_site_directory = site_directory.resolve()

    for page_path, parser in pages.items():
        page_name = page_path.relative_to(resolved_site_directory)
        for reference in parser.references:
            target_path, fragment = local_reference_target(
                resolved_site_directory,
                page_path,
                reference,
            )
            if target_path is None:
                continue

            try:
                target_path.relative_to(resolved_site_directory)
            except ValueError:
                errors.append(f"{page_name}: local reference escapes site: {reference}")
                continue

            if not target_path.is_file():
                errors.append(f"{page_name}: missing local target: {reference}")
                continue

            if fragment:
                target_parser = pages.get(target_path)
                if target_parser is None:
                    errors.append(
                        f"{page_name}: anchor targets a non-HTML file: {reference}"
                    )
                elif fragment not in target_parser.ids:
                    errors.append(f"{page_name}: missing local anchor: {reference}")
    return errors


def verify_sitemap(site_directory: Path) -> list[str]:
    sitemap_path = site_directory / "sitemap.xml"
    if not sitemap_path.is_file():
        return ["missing required site file: sitemap.xml"]

    try:
        root = ElementTree.parse(sitemap_path).getroot()
    except ElementTree.ParseError as exception:
        return [f"invalid sitemap.xml: {exception}"]

    namespace = {"sitemap": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locations = {
        element.text
        for element in root.findall("sitemap:url/sitemap:loc", namespace)
    }
    expected_locations = {
        "https://2bit.jp/maxforge/",
        "https://2bit.jp/maxforge/docs/",
    }
    missing_locations = expected_locations - locations
    return [
        f"sitemap.xml is missing URL: {location}"
        for location in sorted(missing_locations)
    ]


def verify_site(site_directory: Path) -> list[str]:
    errors: list[str] = []
    pages = parse_pages(site_directory)
    resolved_site_directory = site_directory.resolve()
    index_path = (site_directory / "index.html").resolve()
    documentation_path = (site_directory / "docs" / "index.html").resolve()

    if index_path not in pages:
        errors.append(f"missing entry page: {site_directory / 'index.html'}")
    if documentation_path not in pages:
        errors.append("missing documentation entry page: docs/index.html")

    for page_path, parser in pages.items():
        page_name = page_path.relative_to(resolved_site_directory)
        if not parser.title.strip():
            errors.append(f"{page_name}: missing title")
        if not parser.language:
            errors.append(f"{page_name}: missing html lang attribute")
        if parser.heading_one_count != 1:
            errors.append(
                f"{page_name}: expected one h1, found {parser.heading_one_count}"
            )
        for duplicate_id in sorted(parser.duplicate_ids):
            errors.append(f"{page_name}: duplicate id: {duplicate_id}")

    if index_path in pages:
        html = index_path.read_text(encoding="utf-8")
        if "Not affiliated with" not in html:
            errors.append("index.html is missing the unofficial-project disclaimer")
        if "npx maxforge@latest" not in html:
            errors.append("index.html is missing the npx quickstart")
        if 'href="docs/"' not in html:
            errors.append("index.html has no local documentation link")

    if documentation_path in pages:
        documentation_html = documentation_path.read_text(encoding="utf-8")
        required_documentation_ids = {
            "overview",
            "install",
            "first-patch",
            "cli",
            "dsl",
            "generation",
            "connections",
            "subpatchers",
            "mcp",
            "mcp-workflow",
            "mcp-tools",
            "external",
            "recovery",
            "skills",
            "limits",
            "references",
        }
        missing_ids = required_documentation_ids - pages[documentation_path].ids
        for missing_id in sorted(missing_ids):
            errors.append(f"docs/index.html is missing section: {missing_id}")
        if "complete desired" not in documentation_html.lower():
            errors.append("docs/index.html is missing desired-state safety guidance")
        if "not notarized" not in documentation_html.lower():
            errors.append("docs/index.html is missing macOS notarization status")

    errors.extend(verify_page_references(site_directory, pages))
    errors.extend(verify_sitemap(site_directory))

    for required_name in [
        "styles.css",
        "main.js",
        "favicon.svg",
        "docs/docs.css",
    ]:
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

    page_count = len(list(arguments.site_directory.rglob("*.html")))
    print(
        f"GitHub Pages site is valid: {arguments.site_directory} "
        f"({page_count} HTML pages)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
