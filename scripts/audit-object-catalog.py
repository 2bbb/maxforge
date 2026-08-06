#!/usr/bin/env python3
"""Audit maxforge's object catalog against resources bundled with Max 9.

This intentionally uses local primary evidence instead of a hand-maintained list:
reference XML, object indexes/mappings, max.db.json, and saved Max patchers.  The
metadata writer is conservative: it only rewrites entries declared to have
static ports.  Argument-dependent and externally-defined port shapes remain the
responsibility of the compiler's explicit rules.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


PROJECT_OBJECTS = {"maxforge.sync"}
IGNORED_PATCHER_NAMESPACES = {"dsp.gen", "jit.gen", "rnbo"}
IGNORED_PATCHER_PARENT_OBJECTS = {
    "gen",
    "gen~",
    "mc.gen~",
    "jit.gen",
    "jit.pix",
    "jit.gl.pix",
    "rnbo",
    "rnbo~",
}
HELP_STEM_OVERRIDES = {
    "+": "plus",
    "-": "minus",
    "*": "times",
    "/": "div",
    "b": "bangbang",
    "r": "receive",
    "sel": "select",
    "t": "trigger",
}
SUPPORTED_ARG_RULES = {
    "fixed ports, outlettype from first arg",
    "fixed ports, outlettype from numeric arguments",
    "inlets = arg count",
    "inlets = arg count, default 1",
    "inlets = arg count, default 2",
    "inlets = arg count, outlets = arg count - 1",
    "inlets = first arg",
    "inlets = first arg + 1",
    "inlets = first arg, outlets = second arg + status",
    "inlets = format conversion count",
    "inlets = max $i/$f/$s reference index",
    "inlets = outlets = arg count + 1",
    "inlets = outlets = arg count + 1, matched outlets bang",
    "inlets = outlets = arg count, default 1 signal",
    "inlets = outlets = first arg",
    "inlets = second arg + 1, outlets = second arg",
    "inlets = second arg + 2",
    "jit.movie output type from output_texture attribute",
    "one inlet without name, zero with name",
    "outlets = arg count, default 2 signals",
    "outlets = arg count, outlettype from args",
    "outlets = arg count, value types from args",
    "outlets = first arg",
    "outlets = first arg + status",
    "outlets = first arg value",
    "outlets = first arg, default 2 bangs",
    "ports from variable and outN references",
    "signal outlets = channel arg + completion bang",
    "signal outlets = first arg",
    "signal outlets = second arg + completion bang",
    "signal outlets = second arg + sync outlet",
}


@dataclass(frozen=True)
class Observation:
    name: str
    maxclass: str
    numinlets: int
    numoutlets: int
    outlettype: tuple[str, ...]
    text: str | None
    source: Path

    @property
    def shape(self) -> tuple[int, int, tuple[str, ...]]:
        return self.numinlets, self.numoutlets, self.outlettype


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--max-root",
        type=Path,
        default=Path("/Applications/Max.app/Contents/Resources/C74"),
        help="Path to Max's C74 resources directory",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path("data/objects.json"),
        help="Object catalog to audit",
    )
    parser.add_argument(
        "--write-static-metadata",
        action="store_true",
        help="Replace static port metadata with canonical Max 9 help-patch values",
    )
    return parser.parse_args()


def load_catalog(path: Path) -> dict[str, dict[str, Any]]:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(path.read_text(), object_pairs_hook=reject_duplicates)


def iter_saved_patchers(max_root: Path) -> Iterable[Path]:
    yield from max_root.glob("**/*.maxhelp")
    yield from max_root.glob("**/*.maxpat")
    yield from max_root.glob("**/*.maxsnip")


def object_name(box: dict[str, Any]) -> str:
    maxclass = box.get("maxclass", "")
    text = box.get("text")
    if maxclass == "newobj" and isinstance(text, str) and text.strip():
        return text.strip().split()[0]
    return maxclass if isinstance(maxclass, str) else ""


def collect_box_observations(
    patcher: dict[str, Any], source: Path, observations: list[Observation]
) -> None:
    patcher_namespace = patcher.get("classnamespace", "box")
    if patcher_namespace in IGNORED_PATCHER_NAMESPACES or patcher_namespace != "box":
        return
    for wrapper in patcher.get("boxes", []):
        box = wrapper.get("box", {})
        namespace = box.get("classnamespace", "box")
        if namespace not in IGNORED_PATCHER_NAMESPACES:
            name = object_name(box)
            numinlets = box.get("numinlets")
            numoutlets = box.get("numoutlets")
            outlettype = box.get("outlettype", [])
            if (
                name
                and isinstance(numinlets, int)
                and isinstance(numoutlets, int)
                and isinstance(outlettype, list)
                and all(isinstance(value, str) for value in outlettype)
            ):
                observations.append(
                    Observation(
                        name=name,
                        maxclass=box.get("maxclass", ""),
                        numinlets=numinlets,
                        numoutlets=numoutlets,
                        outlettype=tuple(outlettype),
                        text=box.get("text") if isinstance(box.get("text"), str) else None,
                        source=source,
                    )
                )
        child = box.get("patcher")
        if (
            namespace not in IGNORED_PATCHER_NAMESPACES
            and object_name(box) not in IGNORED_PATCHER_PARENT_OBJECTS
            and isinstance(child, dict)
        ):
            collect_box_observations(child, source, observations)


def load_observations(max_root: Path) -> list[Observation]:
    observations: list[Observation] = []
    for path in iter_saved_patchers(max_root):
        try:
            document = json.loads(path.read_text(errors="ignore"))
        except (OSError, json.JSONDecodeError):
            continue
        patcher = document.get("patcher")
        if isinstance(patcher, dict):
            collect_box_observations(patcher, path, observations)
    return observations


def collect_identity_evidence(max_root: Path, observations: list[Observation]) -> set[str]:
    names = {item.name for item in observations}

    # Packages such as Node for Max ship their own reference trees outside the
    # application-level docs/refpages directory.
    for path in max_root.glob("**/*.maxref.xml"):
        try:
            root = ET.parse(path).getroot()
            name = root.get("name") if root.tag == "c74object" else None
        except (OSError, ET.ParseError):
            continue
        if name:
            names.add(name)

    object_list_pattern = re.compile(r'^\s*max\s+oblist\s+"[^"]*"\s+(\S+?)\s*;?\s*$')
    for path in max_root.glob("**/*-objectlist.txt"):
        try:
            for line in path.read_text(errors="ignore").splitlines():
                match = object_list_pattern.match(line)
                if match:
                    names.add(match.group(1))
        except OSError:
            continue

    mapping_pattern = re.compile(r"^\s*max\s+objectfile\s+(\S+)", re.MULTILINE)
    for path in max_root.glob("**/*objectmappings*.txt"):
        try:
            names.update(mapping_pattern.findall(path.read_text(errors="ignore")))
        except OSError:
            continue

    max_db_path = max_root / "interfaces" / "max.db.json"
    try:
        max_db = json.loads(max_db_path.read_text()).get("maxdb", {})
    except (OSError, json.JSONDecodeError):
        max_db = {}
    for key in ("externals", "aliases", "fakeobjects"):
        values = max_db.get(key, {})
        if isinstance(values, dict):
            names.update(values)

    project_root = Path(__file__).resolve().parent.parent
    for name in PROJECT_OBJECTS:
        source = project_root / "source" / "projects" / name / f"{name}.cpp"
        reference = project_root / "docs" / f"{name}.maxref.xml"
        if source.is_file() and reference.is_file():
            names.add(name)

    return names


def mode(values: Iterable[Any]) -> Any | None:
    counts = collections.Counter(values)
    if not counts:
        return None
    # repr provides a deterministic tie-break independent of traversal order.
    return sorted(counts.items(), key=lambda item: (-item[1], repr(item[0])))[0][0]


def canonical_observations(
    name: str, definition: dict[str, Any], observations: list[Observation]
) -> list[Observation]:
    matches = [item for item in observations if item.name == name]
    if not matches:
        return []

    help_stem = HELP_STEM_OVERRIDES.get(name, name)
    own_help = [item for item in matches if item.source.stem == help_stem]
    pool = own_help or matches
    maxclass = definition.get("maxclass")
    if maxclass == "newobj":
        exact = [item for item in pool if item.text is not None and item.text.strip() == name]
    else:
        exact = [item for item in pool if item.maxclass == maxclass and item.text is None]
    return exact or pool


def canonical_shape(
    name: str, definition: dict[str, Any], observations: list[Observation]
) -> tuple[int, int, tuple[str, ...]] | None:
    return mode(item.shape for item in canonical_observations(name, definition, observations))


def canonical_maxclass(name: str, observations: list[Observation]) -> str | None:
    matches = [item for item in observations if item.name == name]
    help_stem = HELP_STEM_OVERRIDES.get(name, name)
    own_help = [item for item in matches if item.source.stem == help_stem]
    return mode(item.maxclass for item in (own_help or matches))


def validate_definition(name: str, definition: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    required = {
        "maxclass": str,
        "numinlets": int,
        "numoutlets": int,
        "outlettype": list,
        "defaultSize": list,
        "category": str,
    }
    for key, expected_type in required.items():
        if not isinstance(definition.get(key), expected_type):
            errors.append(f"{name}: {key} must be {expected_type.__name__}")
    outlets = definition.get("numoutlets")
    outlet_types = definition.get("outlettype")
    inlets = definition.get("numinlets")
    if isinstance(inlets, int) and inlets < 0:
        errors.append(f"{name}: numinlets must not be negative")
    if isinstance(outlets, int) and outlets < 0:
        errors.append(f"{name}: numoutlets must not be negative")
    if isinstance(outlets, int) and isinstance(outlet_types, list) and len(outlet_types) != outlets:
        errors.append(
            f"{name}: outlettype length {len(outlet_types)} does not match numoutlets {outlets}"
        )
    if definition.get("dynamicPorts") and definition.get("argRule"):
        errors.append(f"{name}: use either dynamicPorts or an explicit argument rule, not both")
    rule = definition.get("argRule")
    if rule is not None and rule not in SUPPORTED_ARG_RULES:
        errors.append(f"{name}: unsupported argRule {rule!r}")
    if isinstance(outlet_types, list) and not all(isinstance(value, str) for value in outlet_types):
        errors.append(f"{name}: every outlettype entry must be a string")
    default_size = definition.get("defaultSize")
    if (
        isinstance(default_size, list)
        and (
            len(default_size) != 2
            or not all(isinstance(value, (int, float)) and value > 0 for value in default_size)
        )
    ):
        errors.append(f"{name}: defaultSize must contain two positive numbers")
    return errors


def write_static_metadata(
    path: Path,
    catalog: dict[str, dict[str, Any]],
    observations: list[Observation],
) -> int:
    changed = 0
    for name, definition in catalog.items():
        if (
            definition.get("dynamicPorts")
            or definition.get("argRule")
            or name in PROJECT_OBJECTS
        ):
            continue
        shape = canonical_shape(name, definition, observations)
        if shape is None:
            continue
        numinlets, numoutlets, outlettype = shape
        current = (
            definition.get("numinlets"),
            definition.get("numoutlets"),
            tuple(definition.get("outlettype", [])),
        )
        if current != shape:
            definition["numinlets"] = numinlets
            definition["numoutlets"] = numoutlets
            definition["outlettype"] = list(outlettype)
            changed += 1
    path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    return changed


def main() -> int:
    args = parse_args()
    if not args.max_root.is_dir():
        print(f"error: Max resources not found: {args.max_root}", file=sys.stderr)
        return 2

    try:
        catalog = load_catalog(args.catalog)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"error: cannot load catalog: {error}", file=sys.stderr)
        return 2

    observations = load_observations(args.max_root)
    identities = collect_identity_evidence(args.max_root, observations)

    if args.write_static_metadata:
        changed = write_static_metadata(args.catalog, catalog, observations)
        print(f"updated static metadata for {changed} catalog entries")
        catalog = load_catalog(args.catalog)

    errors: list[str] = []
    warnings: list[str] = []
    for name, definition in catalog.items():
        errors.extend(validate_definition(name, definition))
        if name not in identities:
            errors.append(f"{name}: no identity evidence in bundled Max 9 resources")

        observed_maxclass = canonical_maxclass(name, observations)
        if observed_maxclass is not None and definition.get("maxclass") != observed_maxclass:
            errors.append(
                f"{name}: maxclass {definition.get('maxclass')!r} != observed {observed_maxclass!r}"
            )

        if (
            definition.get("dynamicPorts")
            or definition.get("argRule")
            or name in PROJECT_OBJECTS
        ):
            continue
        shape = canonical_shape(name, definition, observations)
        if shape is None:
            warnings.append(f"{name}: no saved-patcher port observation; identity only")
            continue
        actual = (
            definition.get("numinlets"),
            definition.get("numoutlets"),
            tuple(definition.get("outlettype", [])),
        )
        if actual != shape:
            errors.append(f"{name}: static port metadata {actual!r} != observed {shape!r}")

    print(
        f"catalog={len(catalog)} observations={len(observations)} "
        f"errors={len(errors)} warnings={len(warnings)}"
    )
    for warning in warnings:
        print(f"warning: {warning}")
    for error in errors:
        print(f"error: {error}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
