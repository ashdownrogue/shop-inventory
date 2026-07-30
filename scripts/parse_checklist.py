#!/usr/bin/env python3
"""Convert the shop inventory audit checklist markdown into data/seed.json.

Structure: '## N. Title' -> section, '### N.M Title' -> subsection,
'- [ ] text' -> item. Stable IDs are derived from content so the seed can be
regenerated without orphaning saved user state.
"""
import json
import re
import sys
from pathlib import Path

SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("source/checklist.md")
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("data/seed.json")

SECTION_RE = re.compile(r"^##\s+(\d+)\.\s+(.*?)\s*$")
SUBSECTION_RE = re.compile(r"^###\s+(\d+)\.(\d+)\s+(.*?)\s*$")
ITEM_RE = re.compile(r"^-\s+\[\s*\]\s+(.*?)\s*$")

COUNT_RE = re.compile(r",?\s*count:\s*_+")
WANT_RE = re.compile(r"\(want\s+(?:a\s+)?(\d+|dozen)\+?[^)]*\)", re.I)
PHASE_RE = re.compile(r"\(Phase\s+(\d)", re.I)
BLANK_RE = re.compile(r"_{2,}")

# Coarse store routing so the buy list can be grouped by where you'd actually go.
STORE_RULES = [
    ("Welding supply", ["weld", "tungsten", "argon", "cylinder", "contact tip",
                        "electrode", "mig", "tig", "flux core", "spool gun",
                        "flowmeter", "anti-spatter", "filler"]),
    ("Hobby shop", ["rc ", "shock", "turnbuckle", "lexan", "pinion", "spur",
                    "lipo", "servo", "body clip", "nitro", "glow plug",
                    "body reamer", "droop", "camber", "pit mat", "hex driver",
                    "nut driver", "filament", "nozzle", "build plate", "ptfe",
                    "gridfinity", "printer", "hotend"]),
    ("Electronics", ["solder", "multimeter", "oscilloscope", "flux", "resistor",
                     "capacitor", "breadboard", "esd", "heat shrink", "crimper",
                     "connector", "xt60", "jst", "dupont", "logic analyzer",
                     "bench power supply", "hot air", "desolder", "probe",
                     "microscope", "wire, ", "awg", "transistor", "mosfet",
                     "diode", "led ", "header pin", "programmer", "usb"]),
    ("Auto parts", ["brake", "oil", "coolant", "obd", "spark plug", "lug",
                    "tire", "caliper", "fuel", "battery", "fuse", "relay",
                    "grease", "jack", "torque", "filter", "trim", "gasket",
                    "penetrating", "anti-seize", "thread locker", "rtv",
                    "wheel", "axle", "compression", "leak down", "timing"]),
    ("Harbor Freight", ["vise", "clamp", "grinder", "press", "hammer", "punch",
                        "chisel", "pry", "sledge", "anvil", "cart", "bench",
                        "shop vac", "creeper", "stand", "hoist", "compressor",
                        "abrasive", "cutoff wheel", "flap disc", "sandpaper",
                        "drill", "tap", "die", "socket", "wrench", "plier",
                        "screwdriver", "file", "saw", "extension", "ratchet"]),
]


def slug(text, limit=48):
    s = text.lower()
    s = s.replace('"', "in").replace("'", "")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s[:limit] or "item"


def classify_store(label, section_title):
    hay = (label + " " + section_title).lower()
    for store, keys in STORE_RULES:
        for k in keys:
            if k in hay:
                return store
    return "General"


def parse():
    if not SRC.exists():
        raise SystemExit(f"source not found: {SRC}")
    lines = SRC.read_text(encoding="utf-8").splitlines()

    sections = []
    section = None
    subsection = None
    used_ids = set()
    total_items = 0

    for raw in lines:
        line = raw.rstrip()

        m = SECTION_RE.match(line)
        if m:
            num, title = m.group(1), m.group(2)
            section = {
                "id": f"s{int(num):02d}",
                "num": int(num),
                "title": title.split(" (")[0].strip(),
                "subsections": [],
            }
            sections.append(section)
            subsection = None
            continue

        m = SUBSECTION_RE.match(line)
        if m and section is not None:
            sec_num, sub_num, title = m.group(1), m.group(2), m.group(3)
            subsection = {
                "id": f"{section['id']}-{int(sub_num):02d}",
                "num": f"{sec_num}.{sub_num}",
                "title": title.split(" (")[0].strip(),
                "items": [],
            }
            section["subsections"].append(subsection)
            continue

        m = ITEM_RE.match(line)
        if m and section is not None:
            if subsection is None:
                subsection = {
                    "id": f"{section['id']}-00",
                    "num": f"{section['num']}.0",
                    "title": "General",
                    "items": [],
                }
                section["subsections"].append(subsection)

            text = m.group(1).replace("**", "").strip()

            qty = False
            target = None
            phase = None

            if COUNT_RE.search(text):
                qty = True
                text = COUNT_RE.sub("", text).strip()

            wm = WANT_RE.search(text)
            if wm:
                val = wm.group(1)
                target = 12 if val == "dozen" else int(val)
                qty = True

            pm = PHASE_RE.search(text)
            if pm:
                phase = int(pm.group(1))

            spec = bool(BLANK_RE.search(text))
            text = BLANK_RE.sub("___", text)
            text = re.sub(r"\s{2,}", " ", text).strip().strip(",").strip()

            tags = []
            if section["num"] == 1:
                tags.append("safety")
            if any(w in subsection["title"].lower()
                   for w in ("fire", "medical", "safety", "battery", "charging")):
                if "safety" not in tags:
                    tags.append("safety")
            if qty:
                tags.append("consumable")
            if phase is not None and phase >= 3:
                tags.append("later")

            base = f"{subsection['id']}-{slug(text)}"
            item_id = base
            n = 2
            while item_id in used_ids:
                item_id = f"{base}-{n}"
                n += 1
            used_ids.add(item_id)

            subsection["items"].append({
                "id": item_id,
                "label": text,
                "qty": qty,
                "target": target,
                "spec": spec,
                "phase": phase,
                "tags": tags,
                "store": classify_store(text, section["title"]),
            })
            total_items += 1
            continue

    # Drop empties (tables-only sections like the gap summary).
    for sec in sections:
        sec["subsections"] = [s for s in sec["subsections"] if s["items"]]
        sec["count"] = sum(len(s["items"]) for s in sec["subsections"])
    sections = [s for s in sections if s["subsections"]]

    seed = {
        "version": 1,
        "generated": "2026-07-29",
        "title": "Shop Inventory",
        "totalItems": sum(s["count"] for s in sections),
        "sections": sections,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(seed, separators=(",", ":")), encoding="utf-8")

    print(f"sections: {len(sections)}")
    print(f"items:    {seed['totalItems']}")
    print(f"qty:      {sum(1 for s in sections for ss in s['subsections'] for i in ss['items'] if i['qty'])}")
    print(f"spec:     {sum(1 for s in sections for ss in s['subsections'] for i in ss['items'] if i['spec'])}")
    print(f"safety:   {sum(1 for s in sections for ss in s['subsections'] for i in ss['items'] if 'safety' in i['tags'])}")
    print(f"bytes:    {OUT.stat().st_size}")
    for s in sections:
        print(f"  {s['id']} {s['title'][:44]:<44} {s['count']:>4}")


if __name__ == "__main__":
    parse()
