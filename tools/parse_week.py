import pdfplumber, re, json, sys, datetime

AREA_FIX = {"TKM":"MKT","NIF":"FIN","MRH":"HRM","RPO":"OPR","AB":"BA","MTI":"ITM","EIS":"SIE"}
DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
CELL = re.compile(r"^([A-Za-z0-9]+)-([A-Z])\((\d+)\)\s*\n\s*(.+?)\{(.+)\}\s*$", re.S)
COMMON = re.compile(r"^([A-Za-z0-9]+)\((\d+)\)\s*\n\s*(.+?)\{(.+)\}\s*$", re.S)

def fixrev(s):
    # rotated text comes out reversed
    return "".join(reversed(s)) if s else s

def parse(path):
    with pdfplumber.open(path) as pdf:
        rows, title, header = [], None, None
        for p in pdf.pages:
            t = p.find_tables()[0]
            ext = t.extract()
            for r in ext:
                first = (r[0] or "")
                if first.startswith("INSTITUTE"):
                    m = re.search(r"Term\s*-\s*\S+\s*\[Week-\d+[^\n]*\]", first)
                    title = m.group(0) if m else None
                    header = first
                    continue
                if first == "Day":
                    slots = [re.sub(r"\s+", " ", c).strip() for c in r[2:]]
                    continue
                rows.append(r)
    days, cur_day, cur_area = [], None, None
    for r in rows:
        dtxt = fixrev(r[0] or "").replace("\n", " ").strip()
        if dtxt:
            cur_day = {"label": dtxt, "classes": [], "note": None}
            days.append(cur_day)
        atxt = (r[1] or "").strip()
        if atxt:
            if atxt in AREA_FIX: cur_area = AREA_FIX[atxt]
            else: cur_area = atxt
        # whole-day note row (e.g. SSR Visits): area cell holds the text
        if atxt and atxt not in AREA_FIX and not any(r[2:]):
            cur_day["note"] = atxt
            continue
        for si, c in enumerate(r[2:]):
            c = (c or "").strip()
            if not c: continue
            m = CELL.match(c)
            if m:
                course, sec, sess, fac, room = m.groups()
                cur_day["classes"].append(dict(slot=si, area=cur_area, course=course, section=sec,
                    session=int(sess), faculty=fac.strip(), room=re.sub(r"\s*-\s*", "-", room.strip())))
                continue
            m = COMMON.match(c)
            if m:
                course, sess, fac, room = m.groups()
                cur_day["classes"].append(dict(slot=si, area="ALL", course=course, section="",
                    session=int(sess), faculty=fac.strip(), room=re.sub(r"\s*-\s*", "-", room.strip()), common=True))
                continue
            raise SystemExit(f"Unparsed cell: {c!r}")
    return title, slots, days, header

def to_week(path):
    title, slots, days, header = parse(path)
    lines = [l.strip() for l in (header or "").split("\n")]
    years = re.search(r"\[(\d{4}-\d{2})\]", header or "")
    term = re.search(r"Term\s*-\s*(\S+)", title or "")
    institute = lines[0].title().replace("Of", "of") if lines else ""
    m = re.search(r"Week-(\d+)\s*\((\w+) (\d+) - (\d+), (\d{4})\)", title or "")
    wk, mon, d1, d2, yr = m.groups()
    start = datetime.datetime.strptime(f"{mon} {d1} {yr}", "%B %d %Y").date()
    out_days = []
    for i, d in enumerate(days):
        date = start + datetime.timedelta(days=i)
        label = d["label"]
        if not re.search(r"\d{4}", label):
            label = f"{label}, {date.strftime('%b')}. {date.day:02d}, {date.year}"
        out_days.append(dict(date=date.isoformat(), name=DAYS[i], label=label, note=d["note"], classes=d["classes"]))
    end = start + datetime.timedelta(days=6)
    return dict(id=start.isoformat(), label=f"Week {wk}", title=title, institute=institute,
                programme=f"PGDM {years.group(1)}" if years else "", term=f"Term {term.group(1)}" if term else "",
                start=start.isoformat(), end=end.isoformat(), slots=slots, days=out_days)

def load_js(path):
    try:
        txt = open(path).read()
    except FileNotFoundError:
        return {"weeks": []}
    return json.loads(txt[txt.index("{"):txt.rindex("}")+1])

if __name__ == "__main__":
    pdf, out = sys.argv[1], sys.argv[2]
    w = to_week(pdf)
    data = load_js(out)
    data["weeks"] = [x for x in data["weeks"] if x["id"] != w["id"]] + [w]
    data["weeks"].sort(key=lambda x: x["start"])
    open(out, "w").write("window.TIMETABLE_DATA = " + json.dumps(data, indent=1) + ";\n")
    n = sum(len(d["classes"]) for d in w["days"])
    print(w["label"], w["start"], "->", w["end"], "| classes:", n, "| weeks in file:", len(data["weeks"]))
    print(w["institute"], "|", w["programme"], "|", w["term"])
