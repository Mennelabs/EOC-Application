#!/usr/bin/env python3
"""Extract every requirement-ID definition from docs/00-06.

Writes tools/reqindex/requirements.json: one entry per (namespace, id) with the
source file, line, stated priority, title/summary text and, for IDs that are
defined more than once, every definition site.

Namespaces resolve the three ID families that collide across documents
(see docs/requirements-index.md, "ID collisions"):

  BRD  docs/00 original BRD/FRD           e.g. BRD:DEC-17 (decision register)
  DCL  docs/01 s20 + docs/05 declaration  e.g. DCL:DEC-17 (FEMA field capture)
  BRD:INT-01..07 (integration contracts) vs INT-01.. (s11 intake, plain)
  BRD:FR-xx.yy / FR-A / FR-C (functional) vs FL:FR-01..32 (frontline roles, docs/04)

Everything else keeps its bare ID. Run: python3 tools/reqindex/extract.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"

PRIO_MD = re.compile(r"\((Must|Should|May)\)")
PRIO_TXT = re.compile(r"\bP([012])(?:/P([012]))?\b")

# docs/01..05: "- **ID (Must)** text" (any indentation)
MD_BULLET = re.compile(r"^\s*-\s+\*\*([A-Z][A-Z0-9]{0,5}-\d{2}[A-Z]?)\s*\((Must|Should|May)\)\*\*\s*(.*)$")
# docs/04 tables: "| Role | text | FR-07 |"
MD_TABLE_ID = re.compile(r"^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(FR-\d{2})\s*\|\s*$")

# docs/00 forms
TXT_PATTERNS = [
    # FR-01.03 — P0: text      |  FR-A01 — P0: text
    re.compile(r"^(FR-\d{2}\.\d{2}|FR-[AC]\d{2})\s+—\s+(P[012](?:/P[012])?)\s*:\s*(.*)$"),
    # FR-00.01. TITLE — P0  | BR-01. TITLE — P0 | NFR-01. TITLE — P0 | FR-C06. TITLE — P0/P1
    re.compile(r"^(FR-\d{2}\.\d{2}|FR-[AC]\d{2}|BR-\d{2}|NFR-\d{2})\.\s+(.*?)\s+—\s+(P[012](?:/P[012])?.*)$"),
    # AC-00A: text | AC-A01: | GATE-01: | MIG-01: | AI-01: | RULE-01: (some use '.')
    re.compile(r"^(AC-\d{2}[A-Z]|AC-[AC]\d{2}[A-Z]?|GATE-\d{2}|MIG-\d{2}|AI-\d{2}|RULE-\d{2}|MET-\d{2})[:.]\s+(.*)$"),
    # INT-01. text | DEC-01. text | GOAL-01. TITLE | BP-01. TITLE | ACC-04. TITLE | CMD-01. TITLE
    re.compile(r"^(INT-\d{2}|DEC-\d{2}|GOAL-\d{2}|BP-\d{2}|ACC-\d{2}|CMD-\d{2})\.\s+(.*)$"),
    # F01. AUTHENTICATION, ACCOUNTS, AND PERMISSIONS
    re.compile(r"^(F\d{2})\.\s+([A-Z][A-Z ,/&\-]+)$"),
]

COLLIDING_IN_BRD = ("DEC-", "INT-", "FR-")


def ns_for(source: str, rid: str) -> str:
    if source.startswith("00") and rid.startswith(COLLIDING_IN_BRD):
        return "BRD"
    if rid.startswith("DEC-") and not source.startswith("00"):
        return "DCL"
    if rid.startswith("FR-") and source.startswith("04"):
        return "FL"
    return ""


def norm_priority(raw: str) -> str:
    """Map stated priority to the index class.

    Markdown docs state Must/Should/May directly. The original uses P0/P1/P2
    (docs/00 'PRIORITY CONVENTION'); SCL-14 puts the whole release in scope and
    CLAUDE.md says the stricter rule wins, so P0 and P1 are release-blocking
    (Must). P2 means 'conditional'; Section 29.1 decides each conditional item,
    so P2 lands as Must-if-approved (resolved in build_index.py).
    """
    if raw in ("Must", "Should", "May"):
        return raw
    m = PRIO_TXT.search(raw or "")
    if not m:
        return ""
    best = min(int(m.group(1)), int(m.group(2) or m.group(1)))
    return {0: "Must", 1: "Must", 2: "Conditional"}[best]


def section_of(lines: list[str], idx: int, md: bool) -> str:
    for j in range(idx, -1, -1):
        s = lines[j].strip()
        if md and s.startswith("## "):
            return s[3:]
        if not md and re.match(r"^(PART [AB]|[AB]\d+\.|9\.\d+|10\.\d+)\s", s):
            return s
    return ""


def extract_md(path: Path, out: list[dict]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        m = MD_BULLET.match(line)
        if m:
            rid, prio, text = m.groups()
            out.append(dict(id=rid, source=path.name, line=i + 1, priority_raw=prio,
                            text=text.strip(), section=section_of(lines, i, True)))
            continue
        m = MD_TABLE_ID.match(line)
        if m and path.name.startswith("04"):
            role, text, rid = m.groups()
            out.append(dict(id=rid, source=path.name, line=i + 1, priority_raw="Must",
                            text=f"{role}: {text}", section=section_of(lines, i, True)))


def extract_txt(path: Path, out: list[dict]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    for i, raw in enumerate(lines):
        line = raw.strip()
        for pat in TXT_PATTERNS:
            m = pat.match(line)
            if not m:
                continue
            g = m.groups()
            rid = g[0]
            prio = ""
            if len(g) == 3 and re.fullmatch(r"P[012](?:/P[012])?", g[1]):
                prio, text = g[1], g[2]
            elif len(g) == 3:
                text, prio = g[1], g[2]
            else:
                text = g[1]
                pm = PRIO_TXT.search(text)
                if pm and "—" in text:
                    prio = pm.group(0)
                    text = text.split("—")[0].strip()
            # Titles (ALL CAPS) take the next prose line as their summary.
            title = text.strip()
            if title.isupper() or re.match(r"^(F\d{2}|ACC-|CMD-|BP-|GOAL-)", rid):
                nxt = ""
                for k in range(i + 1, min(i + 6, len(lines))):
                    s = lines[k].strip()
                    if s:
                        nxt = s.lstrip("- ").strip()
                        break
                if nxt and not re.match(r"^([A-Z]{1,5}-\d|Acceptance:)", nxt):
                    title = f"{title.title() if title.isupper() else title}: {nxt}"
            title = re.sub(r"[.:]?\s*Acceptance:?$", ".", title)
            out.append(dict(id=rid, source=path.name, line=i + 1, priority_raw=prio,
                            text=title, section=section_of(lines, i, False)))
            break


def main() -> int:
    raw: list[dict] = []
    for p in sorted(DOCS.glob("0[0-6]-*")):
        (extract_txt if p.suffix == ".txt" else extract_md)(p, raw)

    merged: dict[str, dict] = {}
    for d in raw:
        ns = ns_for(d["source"], d["id"])
        key = f"{ns}:{d['id']}" if ns else d["id"]
        d["priority"] = norm_priority(d["priority_raw"])
        if key in merged:
            merged[key].setdefault("also_defined", []).append(
                dict(source=d["source"], line=d["line"], text=d["text"], priority_raw=d["priority_raw"]))
        else:
            merged[key] = dict(key=key, namespace=ns, **d)

    dst = Path(__file__).with_name("requirements.json")
    dst.write_text(json.dumps(list(merged.values()), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(raw)} definitions -> {len(merged)} unique keys -> {dst.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
