"""Assemble importable n8n workflow JSON from tested sources.

    src/code/*.js   — Code-node logic (unit-tested with `node --test`)
    src/sql/*.sql   — every query n8n runs (tested against the real schema by pytest)
    src/workflows/  — node graphs
    → dist/*.json   — what n8n imports (generated; never edit by hand)

Run:  python apps/workflows/build.py   (CI fails if dist/ is stale)
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from src.workflows import wf_a_crawl, wf_b_match, wf_c_notify, wf_error  # noqa: E402

DIST = Path(__file__).resolve().parent / "dist"
FILES = {"A_crawl.json": wf_a_crawl, "B_match.json": wf_b_match, "C_notify.json": wf_c_notify, "E_errors.json": wf_error}


def render() -> dict[str, str]:
    return {name: json.dumps(module.build(), indent=2, ensure_ascii=False) + "\n" for name, module in FILES.items()}


def main() -> None:
    DIST.mkdir(exist_ok=True)
    for name, text in render().items():
        (DIST / name).write_text(text)
        print(f"wrote dist/{name}")


if __name__ == "__main__":
    main()
