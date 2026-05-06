#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

try:
    import yaml  # type: ignore
except ModuleNotFoundError:
    yaml = None


ROOT = Path(__file__).resolve().parents[1]
PUBLICATIONS_DIR = ROOT / "_data" / "publications"
OUTPUT_PATH = ROOT / "_data" / "publication_order.yml"
RUBY_YAML_LOADER = """
require "date"
require "json"
require "yaml"

path = ARGV.fetch(0)
data = YAML.safe_load(File.read(path), permitted_classes: [Date], aliases: true) || {}
puts JSON.generate(data)
"""


@dataclass(frozen=True)
class Publication:
    publication_id: str
    publication_date: date
    selected: bool
    selected_order: int | None


def parse_date(value: Any, source_path: Path) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError as error:
            raise ValueError(f"Invalid date in {source_path}: {value!r}") from error

    raise ValueError(f"Missing or unsupported date in {source_path}: {value!r}")


def parse_selected_order(value: Any) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, str) and value.strip().lower() in {"none", "null", "nil"}:
        return None

    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Invalid selected_order value: {value!r}") from error


def load_publication(path: Path) -> Publication:
    data = load_yaml(path)

    return Publication(
        publication_id=path.stem,
        publication_date=parse_date(data.get("date"), path),
        selected=bool(data.get("selected")),
        selected_order=parse_selected_order(data.get("selected_order")),
    )


def load_yaml(path: Path) -> dict[str, Any]:
    if yaml is not None:
        with path.open("r", encoding="utf-8") as file:
            return yaml.safe_load(file) or {}

    result = subprocess.run(
        ["ruby", "-e", RUBY_YAML_LOADER, str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def sort_selected(publications: list[Publication]) -> list[str]:
    prioritized = sorted(
        (publication for publication in publications if publication.selected_order is not None),
        key=lambda publication: (
            publication.selected_order if publication.selected_order is not None else 0,
            -publication.publication_date.toordinal(),
            publication.publication_id,
        ),
    )
    remaining = sorted(
        (publication for publication in publications if publication.selected_order is None),
        key=lambda publication: (
            -publication.publication_date.toordinal(),
            publication.publication_id,
        ),
    )
    return [publication.publication_id for publication in prioritized + remaining]


def render_list(key: str, values: list[str]) -> str:
    lines = [f"{key}:"]
    lines.extend(f"  - {value}" for value in values)
    return "\n".join(lines)


def main() -> None:
    publications = [load_publication(path) for path in sorted(PUBLICATIONS_DIR.glob("*.yml"))]

    by_date_asc = [
        publication.publication_id
        for publication in sorted(
            publications,
            key=lambda publication: (
                publication.publication_date,
                publication.publication_id,
            ),
        )
    ]

    selected = sort_selected(
        [publication for publication in publications if publication.selected]
    )

    content = "\n\n".join(
        [
            render_list("by_date_asc", by_date_asc),
            render_list("selected", selected),
        ]
    )
    OUTPUT_PATH.write_text(f"{content}\n", encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
