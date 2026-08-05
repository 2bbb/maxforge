#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


PACKAGE_FILES = (
    "package-info.json",
    "README.md",
    "LICENSE",
    "externals/maxforge.sync.mxo/Contents/Info.plist",
    "externals/maxforge.sync.mxo/Contents/MacOS/maxforge.sync",
    "externals/maxforge.sync.mxe64",
    "help/maxforge.sync.maxhelp",
    "help/managed_plan.json",
    "docs/maxforge.sync.maxref.xml",
)

FILELIST_FILES = (
    "externals/maxforge.sync.mxo",
    "externals/maxforge.sync.mxe64",
    "help/maxforge.sync.maxhelp",
    "help/managed_plan.json",
    "docs/maxforge.sync.maxref.xml",
)


def fail(message: str) -> None:
    raise RuntimeError(message)


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid JSON at {path}: {error}")


def require_file(path: Path) -> None:
    if not path.is_file():
        fail(f"missing required file: {path}")
    if path.stat().st_size == 0:
        fail(f"required file is empty: {path}")


def validate_metadata(root: Path, source_root: Path | None = None) -> None:
    package_info_path = root / "package-info.json"
    package_info = read_json(package_info_path)
    if not isinstance(package_info, dict):
        fail(f"{package_info_path} must contain an object")

    if package_info.get("title") != "maxforge":
        fail(f"{package_info_path} title must be maxforge")

    filelist = package_info.get("filelist")
    if not isinstance(filelist, dict):
        fail(f"{package_info_path} must contain a filelist object")
    missing_filelist = [path for path in FILELIST_FILES if path not in filelist]
    if missing_filelist:
        fail(f"package-info.json filelist is missing: {', '.join(missing_filelist)}")

    if source_root is not None:
        package_json = read_json(source_root / "package.json")
        if not isinstance(package_json, dict):
            fail("package.json must contain an object")
        if package_info.get("version") != package_json.get("version"):
            fail(
                "package-info.json version does not match package.json: "
                f"{package_info.get('version')} != {package_json.get('version')}"
            )


def validate_max_documents(root: Path) -> None:
    maxhelp_path = root / "help/maxforge.sync.maxhelp"
    maxhelp = read_json(maxhelp_path)
    if not isinstance(maxhelp, dict) or not isinstance(maxhelp.get("patcher"), dict):
        fail(f"{maxhelp_path} must contain a Max patcher object")

    plan_path = root / "help/managed_plan.json"
    plan = read_json(plan_path)
    if not isinstance(plan, dict):
        fail(f"{plan_path} must contain an object")

    maxref_path = root / "docs/maxforge.sync.maxref.xml"
    try:
        maxref = ET.parse(maxref_path).getroot()
    except (OSError, ET.ParseError) as error:
        fail(f"invalid Max reference XML at {maxref_path}: {error}")
    if maxref.tag != "c74object" or maxref.attrib.get("name") != "maxforge.sync":
        fail(f"{maxref_path} must describe maxforge.sync")


def validate_source(root: Path) -> None:
    for relative in (
        "package.json",
        "package-info.json",
        "README.md",
        "LICENSE",
        "help/maxforge.sync.maxhelp",
        "help/managed_plan.json",
        "docs/maxforge.sync.maxref.xml",
    ):
        require_file(root / relative)
    validate_metadata(root, root)
    validate_max_documents(root)


def validate_package(root: Path) -> None:
    for relative in PACKAGE_FILES:
        require_file(root / relative)
    validate_metadata(root)
    validate_max_documents(root)

    executable = root / "externals/maxforge.sync.mxo/Contents/MacOS/maxforge.sync"
    if executable.stat().st_mode & stat.S_IXUSR == 0:
        fail(f"macOS external binary is not executable: {executable}")


def validate_archive(path: Path) -> None:
    if not path.is_file():
        fail(f"missing archive: {path}")
    try:
        with zipfile.ZipFile(path) as archive:
            bad_file = archive.testzip()
            if bad_file is not None:
                fail(f"corrupt archive entry: {bad_file}")
            names = set(archive.namelist())
    except (OSError, zipfile.BadZipFile) as error:
        fail(f"invalid zip archive at {path}: {error}")

    missing = [f"maxforge/{relative}" for relative in PACKAGE_FILES if f"maxforge/{relative}" not in names]
    if missing:
        fail(f"archive is missing: {', '.join(missing)}")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate maxforge Max package sources and artifacts")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--source", type=Path)
    mode.add_argument("--package", type=Path)
    mode.add_argument("--archive", type=Path)
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    try:
        if arguments.source is not None:
            validate_source(arguments.source.resolve())
        elif arguments.package is not None:
            validate_package(arguments.package.resolve())
        else:
            validate_archive(arguments.archive.resolve())
    except RuntimeError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
