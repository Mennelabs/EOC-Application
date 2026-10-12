#!/usr/bin/env python3
"""Build docs/requirements-index.md from requirements.json + findings.md.

Layer column (SCL-14 build order):
  1 Foundations · 2 Resident intake · 3 Needs & public help · 4 Missions,
  dispatch & field app · 5 CJIS enclave · 6 FEMA package & reports ·
  7 AI features · 8 ICS & EOC
  All      cross-cutting rule; first built in layer 1/2, re-verified every layer
  Process  compliance/organizational obligation, not code (tracked, evidenced)
  Gov      needs the government-cloud deployment; designed now, proven there
  Trace    business goal/process/feature group; satisfied through its children
  Decision original decision register entry (status in the Note column)
  Deferred blocked on an open decision (Section 21) or missing input

Run: python3 tools/reqindex/extract.py && python3 tools/reqindex/build_index.py
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "docs" / "requirements-index.md"

# ---- layer rules: first match wins (exact key, then regex on key) ----------
EXACT: dict[str, tuple[str, str]] = {
    # --- original rules (RULE) ---
    "RULE-03": ("4", ""), "RULE-04": ("4", ""), "RULE-05": ("4", "Lock policy also enforced on command path (layer 7)."),
    "RULE-06": ("4", ""), "RULE-08": ("2", ""), "RULE-09": ("2", ""), "RULE-10": ("6", ""),
    "RULE-11": ("4", ""), "RULE-12": ("3", ""), "RULE-13": ("7", ""), "RULE-15": ("7", ""),
    "RULE-16": ("2", ""), "RULE-17": ("2", ""), "RULE-18": ("7", ""),
    # --- original NFR / INT ---
    "NFR-01": ("All", ""), "NFR-06": ("2", "Targets come from SCL-03 (50k/h, 10k SMS sessions)."),
    "NFR-07": ("4", "Lag target proposed: ≤5 s console, see findings G-05."), "NFR-08": ("4", "Approved by S29.1 (FLD-13, CHN-07)."),
    "NFR-09": ("All", ""), "NFR-12": ("6", ""),
    "BRD:INT-01": ("1", ""), "BRD:INT-02": ("2", ""), "BRD:INT-03": ("2", ""), "BRD:INT-04": ("2", "Fake provider in dev (AIG-12)."),
    "BRD:INT-05": ("2", "Approved by S29.1 (real SMS/email)."),
    "BRD:INT-06": ("Deferred", "Physical badge printers still open (S21, BRD:DEC-13). Scan validation built in layer 4."),
    "BRD:INT-07": ("Deferred", "CAD out of scope (S29.1); partner case-management feeds open (S21)."),
    # --- original FR overrides ---
    "BRD:FR-04.01": ("4", "Weapons/violence details on law-enforcement missions are CJI → stored in enclave (layer 5)."),
    "BRD:FR-07.02": ("4", "Law-enforcement roles stored in CJIS enclave (PPL-01, layer 5)."),
    "BRD:FR-07.04": ("4", "Bodycam references are CJI → enclave (SEC-12, layer 5)."),
    "BRD:FR-13.05": ("4", "Scan verification approved (S29.1); physical printer integration Deferred (S21)."),
    "BRD:FR-17.05": ("2", "Delivery states needed by SMS intake; applies to every channel (S29.2)."),
    "BRD:FR-C12": ("7", ""),
    # --- Section 11–30 ---
    "PHO-14": ("2", "Need-signal sort in layer 2; AI-severity tie-break added in layer 7."),
    "PHO-16": ("6", ""),
    "NED-01": ("2", "Asked inside the intake flow (decision: damage + needs in one intake)."),
    "NED-02": ("2", ""), "NED-03": ("2", "Consent captured at intake; enforced on sharing in layer 3."), "NED-09": ("2", ""),
    "EQ-11": ("6", ""), "EQ-12": ("6", ""), "EQ-14": ("Process", "Co-design/usability programme; evidence kept per layer."),
    "SEC-01": ("1", "Controls designed in from layer 1; SSP + continuous monitoring evidenced in Process."),
    "SEC-02": ("Process", "3PAO / SOC 2 engagement."), "SEC-03": ("Process", "Legal mapping; Missouri first."),
    "SEC-04": ("1", "Field-level protection of medical fields; BAA-capable providers recorded per adapter."),
    "SEC-12": ("5", ""), "SEC-16": ("Process", "Pen test + VDP; VDP page shipped with layer 3 public site."),
    "SEC-17": ("2", ""), "SEC-19": ("Process", "IR plan; tenant-notification hooks built in layer 1 audit/alerting."),
    "AIG-01": ("2", "Register starts with intake extraction (first AI use)."),
    "AIG-04": ("7", ""), "AIG-09": ("7", ""), "AIG-11": ("Process", ""),
    "SCL-03": ("2", "Load tests start once intake exists (CLAUDE.md rule 7)."), "SCL-04": ("2", ""),
    "SCL-05": ("Gov", "Multi-AZ, warm standby, RPO ≤15 min, RTO ≤1 h need the gov cloud; backup/restore drills run locally from layer 1."),
    "SCL-06": ("2", ""), "SCL-08": ("2", ""), "SCL-09": ("6", ""), "SCL-13": ("2", "Address search + map in intake; offline packages in layer 4."),
    "SCL-14": ("All", ""),
    "DCL:DEC-01": ("2", ""), "DCL:DEC-02": ("2", ""), "DCL:DEC-03": ("2", ""), "DCL:DEC-04": ("2", ""), "DCL:DEC-17": ("2", "Field capture; FEMA output mapping in layer 6."),
    "CALL-01": ("4", ""), "HAZ-01": ("4", ""), "WIT-01": ("2", ""), "HLP-01": ("2", "Helper follow-up access: see findings C-07."),
    "PPL-01": ("4", "Law-enforcement roles/details live in the enclave (layer 5)."),
    "ACCT-01": ("1", ""), "A11Y-01": ("3", ""),
    "MIG-00": ("Deferred", "No source system: Mennelabs has no relationship with ARK (S21). See findings C-04."),
    "MET-00": ("6", ""), "RPT-01": ("6", ""), "CNT-01": ("3", ""),
    "ADM-02": ("3", "Partner onboarding needs DSAs + needs sharing (layer 3); tenancy model in layer 1."),
    "RES-01": ("2", ""), "RES-02": ("2", ""), "ACM-01": ("2", ""), "ORG-01": ("2", ""),
    "CON-01": ("2", "Console shell + role workspaces arrive with the review queue."),
    "CON-02": ("2", ""), "CON-03": ("3", ""), "CON-04": ("3", ""), "CON-05": ("2", "Field-team routing completes in layer 4."),
    "CON-06": ("6", "Sourced sitrep draft; AI narrative assist added in layer 7."), "CON-07": ("6", ""),
    "CON-08": ("3", ""), "CON-09": ("3", ""), "CON-10": ("2", "Danger flags raised by the intake safety screen (INT-07)."),
    "CON-11": ("8", ""), "CON-12": ("7", ""), "CON-13": ("8", ""), "CON-14": ("8", ""), "CON-15": ("3", ""), "CON-16": ("3", ""),
    "CON-17": ("4", "Esri via import/export per SCL-13, see findings C-05."),
    "FL-01": ("2", "Reference code + QR on SMS confirmation; wristband/card printing in layer 3."),
    "FL-02": ("3", ""), "FL-03": ("3", ""), "FL-04": ("7", ""), "FL-05": ("7", ""), "FL-07": ("7", ""),
    "FL-09": ("3", ""), "FL-10": ("3", ""), "FL-11": ("3", ""), "FL-12": ("7", ""), "FL-13": ("3", ""),
    "FL-14": ("7", ""), "FL-18": ("7", ""),
    **{f"FL:FR-{n:02d}": ("3", "") for n in (7, 11, 12, 14, 15, 16, 18, 23, 25, 27, 29, 30, 32)},
    "FL:FR-10": ("6", ""), "FL:FR-31": ("2", "Multi-property reporting (ORG-01)."),
    "FL:FR-03": ("4", "Checkpoint credential scans hold no CJI (SEC-12)."),
    "FL:FR-05": ("4", "Waze update needs Waze for Cities data agreement — ask first (findings Q-04)."),
}

PATTERNS: list[tuple[str, str, str]] = [
    (r"^(GOAL|BR|BP)-|^F\d{2}$", "Trace", ""),
    (r"^BRD:DEC-", "Decision", ""),
    (r"^RULE-", "All", ""),
    (r"^MET-", "6", ""),
    (r"^GATE-", "All", "Checked at the end of every layer."),
    (r"^MIG-", "Deferred", "No source system yet (MIG-00, findings C-04). Generic tenant import reuses the rules."),
    (r"^BRD:FR-00\.|^AC-00", "1", ""),
    (r"^BRD:FR-(01|08|18)\.|^AC-(01|08|18)", "1", ""),
    (r"^BRD:FR-(02|03|04|05|06|07|09|13)\.|^AC-(02|03|04|05|06|07|09|13)", "4", ""),
    (r"^BRD:FR-(10|11|12)\.|^AC-(10|11|12)", "2", ""),
    (r"^BRD:FR-(14|15)\.|^AC-(14|15)", "6", ""),
    (r"^BRD:FR-(16|17)\.|^AC-(16|17)", "3", ""),
    (r"^BRD:FR-A|^AC-A|^ACC-", "All", "Public tasks first proven in layer 2."),
    (r"^BRD:FR-C|^AC-C|^AI-|^CMD-", "7", ""),
    (r"^NFR-", "1", ""),
    (r"^INT-", "2", ""),
    (r"^PHO-(09|1[0-3])$", "7", "Interface, human workflow + eval harness built; severity suggestion OFF until a validated model exists (PHO-12)."),
    (r"^PHO-", "2", ""),
    (r"^(CHN|EQ)-", "2", ""),
    (r"^NED-", "3", ""),
    (r"^SEC-", "1", ""),
    (r"^AIG-", "2", "Applies from the first AI use (intake extraction, fake provider)."),
    (r"^SCL-", "1", ""),
    (r"^DCL:DEC-", "6", ""),
    (r"^PUB-", "3", ""),
    (r"^(MIS|PER|BDG|REM)-", "4", ""),
    (r"^(ADM)-", "1", ""),
    (r"^REC-", "7", ""),
    (r"^(FLD|DSP)-", "4", ""),
    (r"^FL-", "4", ""),
    (r"^FL:FR-", "4", ""),
]

# Release class for IDs whose source states no Must/Should/May.
P2_RESOLUTION = {  # Section 29.1 approvals of original conditional (P2) items
    "BRD:FR-01.06": "Must", "BRD:FR-03.06": "Must", "BRD:FR-05.06": "Must", "BRD:FR-06.08": "Must",
    "BRD:FR-09.06": "Must", "BRD:FR-11.07": "Must", "BRD:FR-13.05": "Must (scan) / Open (printer)",
    "BRD:FR-14.07": "Must", "BRD:FR-16.05": "Must", "BRD:FR-17.04": "Must", "BRD:FR-18.06": "Must",
    "NFR-08": "Must",
}

DECISIONS = {
    "BRD:DEC-01": "Resolved: disasters only (DCL decision 2026-10-12).",
    "BRD:DEC-02": "Resolved: public roles A–F, no public accounts (S29.1, S29.3).",
    "BRD:DEC-03": "Resolved: SCL-01, SCL-02.",
    "BRD:DEC-04": "Resolved: typed units (DSP-02, FR-06.08).",
    "BRD:DEC-05": "Resolved: ADM-04/05 configurable roles + guardrails.",
    "BRD:DEC-06": "Partly: MIS-02 states; transition policy defaults proposed in layer-4 plan.",
    "BRD:DEC-07": "Partly: PER-01/02; release policy defaults proposed in layer-4 plan.",
    "BRD:DEC-08": "Resolved: S29.2 review states + verification levels.",
    "BRD:DEC-09": "Resolved: RES-01/02, SEC-09.",
    "BRD:DEC-10": "OPEN — HLP-01 defers to it. Proposal in findings C-07.",
    "BRD:DEC-11": "Resolved: EN + ES (EQ-06).",
    "BRD:DEC-12": "Mostly: INT-20, FLD-13, DSP-08. Draft retention default proposed (findings G-03).",
    "BRD:DEC-13": "OPEN (S21): physical badge printers.",
    "BRD:DEC-14": "Partly: Twilio SMS/voice decided; email provider not chosen (findings Q-02).",
    "BRD:DEC-15": "Partly: tenant-configured periods; defaults in layer-6 plan.",
    "BRD:DEC-16": "OPEN (S21): S30.2 defaults awaiting approval; built behind a flag in layer 7.",
    "BRD:DEC-17": "Resolved: AIG-06/08/12 pluggable providers; real provider chosen per tenant.",
    "BRD:DEC-18": "Resolved: SCL-03, SCL-05, SEC-13.",
    "BRD:DEC-19": "Partly: WCAG 2.2 AA + axe + manual checklist; severity criteria proposed (findings G-06).",
    "BRD:DEC-20": "OPEN: no migration source (findings C-04).",
    "BRD:DEC-21": "Partly: Twilio decided; any other paid service needs approval.",
    "BRD:DEC-22": "Resolved: SCL-14 release 1 = everything, layered build.",
}


def layer_for(key: str) -> tuple[str, str]:
    if key in EXACT:
        return EXACT[key]
    for pat, layer, note in PATTERNS:
        if re.search(pat, key):
            return layer, note
    return "?", "UNMAPPED"


def release_class(e: dict, layer: str) -> str:
    k = e["key"]
    if k in P2_RESOLUTION:
        return P2_RESOLUTION[k]
    if e["priority"] in ("Must", "Should", "May"):
        return e["priority"]
    if layer in ("Trace", "Decision"):
        return "—"
    if k in ("BRD:INT-06", "BRD:INT-07"):
        return "Open"
    return "Must"  # RULE, AI, GATE, AC, MET, ACC, CMD, INT, MIG: system-wide (S29 preamble)


def fmt_source(e: dict) -> str:
    s = f"{e['source'][:2]}:{e['line']}"
    for a in e.get("also_defined", []):
        s += f", {a['source'][:2]}:{a['line']}"
    return s


def clean(t: str, n: int = 150) -> str:
    t = re.sub(r"\s+", " ", t).replace("|", "/").replace("\\_", "_")
    t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def main() -> None:
    entries = json.loads((HERE / "requirements.json").read_text(encoding="utf-8"))
    rows, unmapped = [], []
    for e in entries:
        layer, note = layer_for(e["key"])
        if layer == "?":
            unmapped.append(e["key"])
        if e["key"] in DECISIONS:
            note = DECISIONS[e["key"]]
        rows.append(dict(e, layer=layer, note=note, rclass=release_class(e, layer)))
    if unmapped:
        raise SystemExit(f"unmapped IDs: {unmapped}")

    by_layer = Counter(r["layer"] for r in rows)
    by_class = Counter(r["rclass"] for r in rows)
    order = ["1", "2", "3", "4", "5", "6", "7", "8", "All", "Gov", "Process", "Deferred", "Trace", "Decision"]

    out: list[str] = []
    w = out.append
    w("# Requirements index\n")
    w("Generated by `tools/reqindex/build_index.py` from `docs/00`–`06` "
      "(requirements exported 2026-10-12). **Do not edit the table by hand.** Change the layer rules in the script "
      "or the findings in `tools/reqindex/findings.md`, then regenerate:\n")
    w("```sh\npython3 tools/reqindex/extract.py && python3 tools/reqindex/build_index.py\n```\n")
    w(f"**{len(rows)} requirement IDs** from {len(set(r['source'] for r in rows))} source files.\n")
    w("## How to read this\n")
    w("- **Key**: the ID used in code, tests and commits. Three ID families collide across documents, so they carry a "
      "namespace prefix: `BRD:` (original BRD/FRD), `DCL:` (Section 20 declaration support + docs/05) and `FL:` "
      "(frontline-role features in docs/04). All other IDs are unique and stay bare. See finding C-01.")
    w("- **Class**: Must/Should/May as stated in docs/01–05. The original states P0/P1/P2: P0 and P1 are treated as "
      "**Must** (SCL-14 puts the whole release in scope; stricter rule wins). P2 items are resolved through the "
      "Section 29.1 approvals. Unprioritized system-wide rules (RULE, AI, ACC, CMD, GATE, acceptance cases) are Must "
      "(Section 29 preamble).")
    w("- **Layer**: SCL-14 build layer 1–8. `All` = cross-cutting, built first where it is first needed and re-tested in "
      "every layer. `Gov` = needs the government cloud. `Process` = compliance/organizational evidence, not code. "
      "`Deferred` = blocked on an open decision. `Trace` = business goal/feature group satisfied through its children. "
      "`Decision` = original decision register entry.")
    w("- **Source**: `file-prefix:line`, e.g. `00:506` = docs/00-original-BRD-FRD.txt line 506.\n")
    w("## Counts\n")
    w("| Layer | IDs |\n| --- | ---: |")
    for k in order:
        if by_layer.get(k):
            w(f"| {k} | {by_layer[k]} |")
    w("")
    w("| Class | IDs |\n| --- | ---: |")
    for k, v in sorted(by_class.items(), key=lambda kv: -kv[1]):
        w(f"| {k} | {v} |")
    w("")
    w((HERE / "findings.md").read_text(encoding="utf-8").rstrip() + "\n")

    w("## Index by layer\n")
    groups = defaultdict(list)
    for r in rows:
        groups[r["layer"]].append(r)
    names = {"1": "Layer 1 — Foundations", "2": "Layer 2 — Resident intake, review queue, verification",
             "3": "Layer 3 — Needs board, partner sharing, public Find help", "4": "Layer 4 — Missions, dispatch, field app",
             "5": "Layer 5 — CJIS enclave", "6": "Layer 6 — FEMA package and official reports",
             "7": "Layer 7 — AI features and command window", "8": "Layer 8 — ICS forms and EOC functions",
             "All": "Cross-cutting (every layer)", "Gov": "Government-cloud deployment", "Process": "Compliance process",
             "Deferred": "Deferred (open decision)", "Trace": "Business trace (goals, processes, feature groups)",
             "Decision": "Original decision register (BRD:DEC)"}
    for k in order:
        if not groups.get(k):
            continue
        w(f"### {names[k]}\n")
        w("| Key | Source | Class | Summary | Note |\n| --- | --- | --- | --- | --- |")
        for r in groups[k]:
            w(f"| {r['key']} | {fmt_source(r)} | {r['rclass']} | {clean(r['text'])} | {clean(r['note'], 200)} |")
        w("")
    OUT.write_text("\n".join(out), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} rows; layers {dict(by_layer)}")


if __name__ == "__main__":
    main()
