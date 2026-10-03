# Class timetable site

Students pick their courses and sections once and see their own week in the same
layout as the institute PDF. Everything is static files. No server or login.

## Files

- `index.html`     student page
- `admin.html`     weekly upload page (reads the PDF in the browser, nothing is sent anywhere)
- `data/weeks.js`  all published weeks (this is the only file that changes weekly)
- `vendor/`        pdf.js, used by the upload page
- `tools/parse_week.py`  optional command line version of the upload page

## Publishing

Put the folder on any static host (Netlify Drop, GitHub Pages, Cloudflare Pages,
your own server). Share the link to `index.html`.

## Every week

1. Open `admin.html` on your site and choose the new PDF.
2. Compare the preview with the PDF. Fix anything listed in red.
3. Click "Download weeks.js" and replace `data/weeks.js` on your host.

Uploading a PDF for a week that is already published replaces that week.

## Command line alternative

    pip install pdfplumber
    python tools/parse_week.py new_week.pdf data/weeks.js

## Notes

- Courses are identified as course plus section, for example `CWB-B`.
- Rows with no section, such as FINPrep, and whole day entries such as SSR Visits,
  are shown to everyone.
- The upload page needs the same table template (day, area, 7 time slots).
  If the layout changes it stops and says so instead of guessing.
