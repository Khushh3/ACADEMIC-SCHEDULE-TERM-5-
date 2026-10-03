/* Reads the weekly timetable PDF (day, area, 7 time slots) in the browser.
   Needs pdf.js (vendor/pdf.min.js) loaded first.
   TimetableParser.parsePdf(bytes, existingData) -> { week, warnings, total, braces } */
(function () {
  "use strict";
  var DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  var SCALE = 2;
  var WORKER = "vendor/pdf.worker.min.js";

  function lib() {
    var l = window["pdfjs-dist/build/pdf"] || window.pdfjsLib;
    if (!l) throw new Error("The PDF reader did not load.");
    l.GlobalWorkerOptions.workerSrc = WORKER;
    return l;
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDays(isoStr, n) { var p = isoStr.split("-"); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)); return iso(d); }

  /* ------------------------------------------------------------------
     1. Read each PDF page: text items with positions, and a dark-pixel map
     ------------------------------------------------------------------ */
  async function readPages(buffer) {
    var pdfjsLib = lib();
    var pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    var pages = [];
    for (var n = 1; n <= pdf.numPages; n++) {
      var page = await pdf.getPage(n);
      var vp = page.getViewport({ scale: SCALE });
      var canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      var w = canvas.width, h = canvas.height, dark = new Uint8Array(w * h);
      for (var i = 0, j = 0; i < img.length; i += 4, j++) dark[j] = (0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]) < 110 ? 1 : 0;

      var tc = await page.getTextContent(), items = [];
      tc.items.forEach(function (it) {
        if (!it.str || !it.str.trim()) return;
        var tx = pdfjsLib.Util.transform(vp.transform, it.transform);
        var hgt = Math.hypot(tx[2], tx[3]), norm = Math.hypot(tx[0], tx[1]) || 1;
        var ux = tx[0] / norm, uy = tx[1] / norm, len = it.width * SCALE;
        items.push({
          str: it.str, x0: tx[4], y0: tx[5], ux: ux, uy: uy, len: len, hgt: hgt,
          horiz: Math.abs(uy) < 0.3,
          cx: tx[4] + ux * len / 2 + uy * hgt * 0.3,
          cy: tx[5] + uy * len / 2 - ux * hgt * 0.3
        });
      });
      pages.push({ w: w, h: h, dark: dark, items: items });
    }
    return pages;
  }

  /* ------------------------------------------------------------------
     2. Find the table borders from the rendered page
     ------------------------------------------------------------------ */
  function cluster(vals, gap) {
    var out = [], cur = null;
    vals.forEach(function (v) {
      if (cur && v - cur.max <= gap) { cur.max = v; } else { cur = { min: v, max: v }; out.push(cur); }
    });
    return out.map(function (c) { return (c.min + c.max) / 2; });
  }
  function verticalLines(pg) {
    var w = pg.w, h = pg.h, best = new Int32Array(w), top = new Int32Array(w).fill(h), bot = new Int32Array(w);
    for (var x = 0; x < w; x++) {
      var run = 0, runStart = 0;
      for (var y = 0; y < h; y++) {
        if (pg.dark[y * w + x]) { if (!run) runStart = y; run++; if (run > best[x]) { best[x] = run; top[x] = runStart; bot[x] = y; } }
        else run = 0;
      }
    }
    /* The outer border gives the table height; inner column lines may be drawn in
       segments, so count dark pixels over that height instead of one unbroken run. */
    var max = 0, outer = 0; for (x = 0; x < w; x++) if (best[x] > max) { max = best[x]; outer = x; }
    var t = top[outer], b = bot[outer], height = b - t, xs = [];
    for (x = 0; x < w; x++) {
      var n = 0; for (y = t; y <= b; y++) n += pg.dark[y * w + x];
      if (n >= 0.8 * height) xs.push(x);
    }
    return { xs: cluster(xs, 3), top: t, bottom: b };
  }
  function horizontalLines(pg, x0, x1, top, bottom) {
    var w = pg.w, a = Math.round(x0) + 4, b = Math.round(x1) - 4, ys = [];
    for (var y = Math.max(0, Math.floor(top) - 3); y <= Math.min(pg.h - 1, Math.ceil(bottom) + 3); y++) {
      var n = 0; for (var x = a; x < b; x++) n += pg.dark[y * w + x];
      if (n >= 0.85 * (b - a)) ys.push(y);
    }
    return cluster(ys, 3);
  }
  function blocks(borders) {
    var out = [];
    for (var i = 0; i + 1 < borders.length; i++) if (borders[i + 1] - borders[i] > 12) out.push({ y0: borders[i], y1: borders[i + 1] });
    return out;
  }

  /* ------------------------------------------------------------------
     3. Text helpers
     ------------------------------------------------------------------ */
  function inBox(it, x0, x1, y0, y1) { return it.cx >= x0 && it.cx < x1 && it.cy >= y0 && it.cy < y1; }
  function textLines(items) {
    var hs = items.filter(function (i) { return i.horiz; }).sort(function (a, b) { return a.cy - b.cy || a.cx - b.cx; });
    var lines = [];
    hs.forEach(function (it) {
      var last = lines[lines.length - 1];
      if (last && Math.abs(last.cy - it.cy) < 0.5 * it.hgt) last.items.push(it);
      else lines.push({ cy: it.cy, items: [it] });
    });
    return lines.map(function (ln) {
      ln.items.sort(function (a, b) { return a.cx - b.cx; });
      var s = "", prevEnd = null;
      ln.items.forEach(function (it) {
        if (prevEnd !== null && it.x0 - prevEnd > 0.3 * it.hgt && !/^\s/.test(it.str)) s += " ";
        s += it.str; prevEnd = it.x0 + it.len;
      });
      return s.replace(/\s+/g, " ").trim();
    });
  }
  function rotatedText(items) {
    var v = items.filter(function (i) { return !i.horiz; });
    if (!v.length) return "";
    var up = v[0].uy < 0;
    v.sort(function (a, b) { return up ? b.cy - a.cy : a.cy - b.cy; });
    return v.map(function (i) { return i.str; }).join("").replace(/\s+/g, " ").trim();
  }

  /* ------------------------------------------------------------------
     4. Parse the week
     ------------------------------------------------------------------ */
  var CELL = /^\s*([A-Za-z0-9]+)\s*-\s*([A-Z])\s*\(\s*(\d+)\s*\)\s*\n\s*(.+?)\s*\{(.+)\}\s*$/;
  var COMMON = /^\s*([A-Za-z0-9]+)\s*\(\s*(\d+)\s*\)\s*\n\s*(.+?)\s*\{(.+)\}\s*$/;

  function knownAreas(EXISTING) {
    var set = { MKT: 1, FIN: 1, HRM: 1, OPR: 1, BA: 1, ITM: 1, SIE: 1 };
    EXISTING.weeks.forEach(function (w) { w.days.forEach(function (d) { d.classes.forEach(function (c) { if (c.area && c.area !== "ALL") set[c.area] = 1; }); }); });
    return set;
  }
  function fixArea(s, known) {
    s = s.replace(/\s+/g, "");
    if (known[s]) return s;
    var r = s.split("").reverse().join("");
    return known[r] ? r : s;
  }
  function parseDayLabel(s) {
    var wd = /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.exec(s);
    var m = /([A-Za-z]{3})[a-z]*\.?,?\s*(\d{1,2}),?\s*(\d{4})/.exec(s);
    var date = null;
    if (m && MONTHS.indexOf(m[1].toLowerCase()) >= 0) date = m[3] + "-" + pad(MONTHS.indexOf(m[1].toLowerCase()) + 1) + "-" + pad(+m[2]);
    return { wd: wd ? DAY_NAMES.indexOf(wd[1][0].toUpperCase() + wd[1].slice(1).toLowerCase()) : -1, date: date, raw: s };
  }

  function parseWeek(pages, EXISTING) {
    var warnings = [], known = knownAreas(EXISTING), days = [], slots = null, headerLines = [], textBraces = 0;

    pages.forEach(function (pg, pi) {
      pg.items.forEach(function (it) { var m = it.str.match(/\{/g); if (m) textBraces += m.length; });
      var vl = verticalLines(pg);
      if (vl.xs.length !== 10) throw new Error("Page " + (pi + 1) + ": expected 9 table columns (day, area and 7 time slots) but found " + (vl.xs.length - 1) + ". Is this the usual template?");
      var v = vl.xs;
      var slotB = horizontalLines(pg, v[2], v[9], vl.top, vl.bottom);
      var areaB = horizontalLines(pg, v[1], v[2], vl.top, vl.bottom);
      var dayB = horizontalLines(pg, v[0], v[1], vl.top, vl.bottom);
      var slotBlocks = blocks(slotB);
      if (slotBlocks.length < 2) throw new Error("Page " + (pi + 1) + ": could not find table rows.");
      var header = slotBlocks[0], rows = slotBlocks.slice(1);

      if (pi === 0) headerLines = textLines(pg.items.filter(function (i) { return i.cy < header.y0 - 2; }));
      if (!slots) {
        slots = [];
        for (var c = 0; c < 7; c++) {
          var hi = pg.items.filter(function (i) { return inBox(i, v[2 + c], v[3 + c], header.y0, header.y1); });
          slots.push(textLines(hi).join(" "));
        }
      }

      var dayBlocks = blocks(dayB).filter(function (b) { return b.y0 >= header.y1 - 4; });
      var areaBlocks = blocks(areaB).filter(function (b) { return b.y0 >= header.y1 - 4; });
      var dayObjs = dayBlocks.map(function (b, k) {
        var label = rotatedText(pg.items.filter(function (i) { return inBox(i, v[0], v[1], b.y0, b.y1); }));
        if (!label) {
          label = textLines(pg.items.filter(function (i) { return inBox(i, v[0], v[1], b.y0, b.y1); })).join(" ");
        }
        var info = parseDayLabel(label), obj;
        if (!label && days.length && k === 0 && pi > 0) obj = days[days.length - 1];
        else { obj = { info: info, classes: [], note: null }; days.push(obj); }
        return { b: b, obj: obj };
      });
      var areaNames = areaBlocks.map(function (b) {
        var lab = rotatedText(pg.items.filter(function (i) { return inBox(i, v[1], v[2], b.y0, b.y1); }));
        return { b: b, name: lab ? fixArea(lab, known) : null };
      });

      rows.forEach(function (r) {
        var mid = (r.y0 + r.y1) / 2;
        var dayHit = dayObjs.filter(function (d) { return mid >= d.b.y0 && mid < d.b.y1; })[0];
        var areaHit = areaNames.filter(function (a) { return mid >= a.b.y0 && mid < a.b.y1; })[0];
        if (!dayHit) { warnings.push("A row on page " + (pi + 1) + " does not belong to any day block and was skipped."); return; }
        var day = dayHit.obj, area = areaHit && areaHit.name, parsed = 0, leftovers = [];
        /* a blank area cell means the row belongs to the area above it, on the same day */
        if (area) day.lastArea = area; else area = day.lastArea || null;
        for (var c = 0; c < 7; c++) {
          var its = pg.items.filter(function (i) { return inBox(i, v[2 + c], v[3 + c], r.y0, r.y1); });
          if (!its.length) continue;
          var text = textLines(its).join("\n"), m;
          if ((m = CELL.exec(text))) {
            day.classes.push({ slot: c, area: area || "?", course: m[1], section: m[2], session: +m[3], faculty: m[4].trim(), room: m[5].trim().replace(/\s*-\s*/g, "-") });
            parsed++;
          } else if ((m = COMMON.exec(text))) {
            day.classes.push({ slot: c, area: "ALL", course: m[1], section: "", session: +m[2], faculty: m[3].trim(), room: m[4].trim().replace(/\s*-\s*/g, "-"), common: true });
            parsed++;
          } else leftovers.push({ c: c, text: text.replace(/\n/g, " ") });
        }
        if (leftovers.length) {
          if (!parsed && !day.classes.length) day.note = ((day.note ? day.note + " " : "") + leftovers.map(function (l) { return l.text; }).join(" ")).trim();
          else leftovers.forEach(function (l) { warnings.push("Could not read a cell (" + (day.info.raw || "day") + ", slot " + (l.c + 1) + "): \"" + l.text + "\""); });
        }
        if (!area && parsed) warnings.push("No area found for a row on " + (day.info.raw || "a day") + ".");
      });
    });

    /* dates: anchor on any day that carries a full date */
    var anchor = days.filter(function (d) { return d.info.date && d.info.wd >= 0; })[0];
    if (!anchor) throw new Error("No dates found in the day column.");
    var monday = addDays(anchor.info.date, -anchor.info.wd);
    var outDays = days.map(function (d, i) {
      var wd = d.info.wd >= 0 ? d.info.wd : i;
      var date = addDays(monday, wd);
      if (d.info.date && d.info.date !== date) warnings.push("Date on " + d.info.raw + " does not fit the week.");
      var p = date.split("-"), dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
      var label = d.info.date ? d.info.raw : DAY_NAMES[wd] + ", " + dt.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }) + ". " + p[2] + ", " + p[0];
      return { date: date, name: DAY_NAMES[wd], label: label, note: d.note, classes: d.classes };
    });
    if (outDays.length !== 7) warnings.push("Found " + outDays.length + " days instead of 7.");

    /* a course that moved to another area compared with earlier weeks is worth a look */
    var seen = {};
    EXISTING.weeks.forEach(function (x) { x.days.forEach(function (d) { d.classes.forEach(function (c) { if (!c.common) seen[c.course] = c.area; }); }); });
    var flagged = {};
    outDays.forEach(function (d) { d.classes.forEach(function (c) {
      if (!c.common && seen[c.course] && seen[c.course] !== c.area && !flagged[c.course]) {
        flagged[c.course] = 1; warnings.push(c.course + " is under " + c.area + " here but was under " + seen[c.course] + " in an earlier week.");
      }
    }); });

    var head = headerLines.join("\n");
    var wk = /Week\s*-?\s*(\d+)/i.exec(head), term = /Term\s*-?\s*([A-Za-z0-9]+)/i.exec(head), years = /\[(\d{4}-\d{2})\]/.exec(head);
    var title = (/Term[^\n]*/i.exec(head) || [""])[0];
    var institute = (headerLines[0] || "").toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }).replace(/\bOf\b/, "of");
    var total = outDays.reduce(function (n, d) { return n + d.classes.length; }, 0);
    if (total !== textBraces) warnings.push("The PDF has " + textBraces + " cells with a faculty and room, but " + total + " were read.");
    if (!wk) warnings.push("Week number not found in the PDF heading.");

    return {
      week: {
        id: monday, label: wk ? "Week " + wk[1] : "Week of " + monday, title: title, institute: institute,
        programme: years ? "PGDM " + years[1] : "", term: term ? "Term " + term[1] : "",
        start: monday, end: addDays(monday, 6), slots: slots, days: outDays
      },
      warnings: warnings, total: total, braces: textBraces
    };
  }

  window.TimetableParser = {
    setWorkerPath: function (p) { WORKER = p; },
    parsePdf: async function (bytes, existing) {
      var pages = await readPages(bytes);
      return parseWeek(pages, existing || { weeks: [] });
    }
  };
})();
