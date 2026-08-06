#!/usr/bin/env python3

from __future__ import annotations

import argparse
from collections import Counter
import json
import plistlib
from pathlib import PurePosixPath
import re
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

SEMVER_PATTERN = re.compile(
    r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"
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


def validate_relative_path(path: object, field: str) -> str:
    if not isinstance(path, str) or not path:
        fail(f"{field} must be a non-empty relative POSIX path")
    candidate = PurePosixPath(path)
    if (
        path.startswith("/")
        or "\\" in path
        or any(part in ("", ".", "..") for part in candidate.parts)
        or str(candidate) != path
    ):
        fail(f"unsafe {field}: {path!r}")
    return path


def validate_os_paths(package_info: dict[str, object], package_info_path: Path) -> None:
    os_metadata = package_info.get("os")
    if not isinstance(os_metadata, dict):
        fail(f"{package_info_path} must contain os metadata")
    for platform in ("macintosh", "windows"):
        platform_metadata = os_metadata.get(platform)
        if not isinstance(platform_metadata, dict):
            fail(f"{package_info_path} is missing os.{platform}")
        for category, expected in (
            ("externals", "externals/"),
            ("help", "help/"),
        ):
            paths = platform_metadata.get(category)
            if not isinstance(paths, list) or expected not in paths:
                fail(f"{package_info_path} os.{platform}.{category} must include {expected}")


def validate_metadata(
    root: Path,
    source_root: Path | None = None,
    require_targets: bool = False,
) -> None:
    package_info_path = root / "package-info.json"
    package_info = read_json(package_info_path)
    if not isinstance(package_info, dict):
        fail(f"{package_info_path} must contain an object")

    if package_info.get("title") != "maxforge":
        fail(f"{package_info_path} title must be maxforge")
    for field in ("description", "author", "website", "max_version_min"):
        if not isinstance(package_info.get(field), str) or not package_info[field].strip():
            fail(f"{package_info_path} {field} must be a non-empty string")
    version = package_info.get("version")
    if not isinstance(version, str) or not SEMVER_PATTERN.fullmatch(version):
        fail(f"{package_info_path} version must be semantic version text")
    validate_os_paths(package_info, package_info_path)

    filelist = package_info.get("filelist")
    if not isinstance(filelist, dict):
        fail(f"{package_info_path} must contain a filelist object")
    missing_filelist = [path for path in FILELIST_FILES if path not in filelist]
    if missing_filelist:
        fail(f"package-info.json filelist is missing: {', '.join(missing_filelist)}")
    for relative, metadata in filelist.items():
        relative = validate_relative_path(relative, "filelist path")
        if not isinstance(metadata, dict):
            fail(f"package-info.json filelist entry must be an object: {relative}")
        if require_targets:
            target = root / relative
            if not target.exists():
                fail(f"package-info.json filelist target does not exist: {relative}")

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
    help_patcher = maxhelp["patcher"]
    if not isinstance(help_patcher.get("boxes"), list) or not isinstance(
        help_patcher.get("lines"), list
    ):
        fail(f"{maxhelp_path} patcher must contain boxes and lines arrays")
    if not any(
        isinstance(wrapper, dict)
        and isinstance(wrapper.get("box"), dict)
        and wrapper["box"].get("maxclass") == "newobj"
        and isinstance(wrapper["box"].get("text"), str)
        and wrapper["box"]["text"].split(maxsplit=1)[0] == "maxforge.sync"
        for wrapper in help_patcher["boxes"]
    ):
        fail(f"{maxhelp_path} does not instantiate maxforge.sync")

    plan_path = root / "help/managed_plan.json"
    plan = read_json(plan_path)
    if not isinstance(plan, dict):
        fail(f"{plan_path} must contain an object")
    if plan.get("protocolVersion") != 1 or not isinstance(plan.get("operations"), list):
        fail(f"{plan_path} must contain protocolVersion 1 and an operations array")

    maxref_path = root / "docs/maxforge.sync.maxref.xml"
    try:
        maxref = ET.parse(maxref_path).getroot()
    except (OSError, ET.ParseError) as error:
        fail(f"invalid Max reference XML at {maxref_path}: {error}")
    if maxref.tag != "c74object" or maxref.attrib.get("name") != "maxforge.sync":
        fail(f"{maxref_path} must describe maxforge.sync")
    if maxref.find("digest") is None or maxref.find("methodlist") is None:
        fail(f"{maxref_path} must contain a digest and methodlist")


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
    validate_metadata(root, require_targets=True)
    validate_max_documents(root)

    executable = root / "externals/maxforge.sync.mxo/Contents/MacOS/maxforge.sync"
    if executable.stat().st_mode & stat.S_IXUSR == 0:
        fail(f"macOS external binary is not executable: {executable}")
    if executable.read_bytes()[:4] not in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        fail(f"macOS external is not a universal Mach-O binary: {executable}")

    windows_external = root / "externals/maxforge.sync.mxe64"
    if windows_external.read_bytes()[:2] != b"MZ":
        fail(f"Windows external is not a PE binary: {windows_external}")

    plist_path = root / "externals/maxforge.sync.mxo/Contents/Info.plist"
    try:
        with plist_path.open("rb") as stream:
            plist = plistlib.load(stream)
    except (OSError, plistlib.InvalidFileException) as error:
        fail(f"invalid macOS Info.plist at {plist_path}: {error}")
    if plist.get("CFBundleIdentifier") != "jp.2bit.maxforge.sync":
        fail(f"invalid maxforge.sync bundle identifier in {plist_path}")

    package_info = read_json(root / "package-info.json")
    if not isinstance(package_info, dict):
        fail("package-info.json must contain an object")
    if plist.get("CFBundleShortVersionString") != package_info.get("version"):
        fail("macOS bundle version does not match package-info.json")


def validate_archive(path: Path) -> None:
    if not path.is_file():
        fail(f"missing archive: {path}")
    try:
        with zipfile.ZipFile(path) as archive:
            bad_file = archive.testzip()
            if bad_file is not None:
                fail(f"corrupt archive entry: {bad_file}")
            infos = archive.infolist()
            names = [info.filename for info in infos]
    except (OSError, zipfile.BadZipFile) as error:
        fail(f"invalid zip archive at {path}: {error}")

    duplicates = [name for name, count in Counter(names).items() if 1 < count]
    if duplicates:
        fail(f"archive contains duplicate entries: {', '.join(sorted(duplicates))}")
    for name in names:
        normalized = validate_relative_path(name.rstrip("/"), "archive path")
        if normalized != "maxforge" and not normalized.startswith("maxforge/"):
            fail(f"archive entry is outside maxforge/: {name}")
    name_set = set(names)
    missing = [
        f"maxforge/{relative}"
        for relative in PACKAGE_FILES
        if f"maxforge/{relative}" not in name_set
    ]
    if missing:
        fail(f"archive is missing: {', '.join(missing)}")
    empty = [
        info.filename
        for info in infos
        if info.filename in {f"maxforge/{relative}" for relative in PACKAGE_FILES}
        and info.file_size == 0
    ]
    if empty:
        fail(f"archive contains empty required files: {', '.join(empty)}")


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
