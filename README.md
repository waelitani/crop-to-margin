# Crop to Margin

A Zotero plugin that zooms past a PDF's white margins so the text block fills
the reader instead of the paper it was printed on.

Books are typeset for paper. A 6×9″ page with 1″ margins wastes about a third of
its width on nothing, and Zotero's "fit page width" faithfully reproduces that
waste on a screen you are reading at arm's length. **Crop to Margin** measures
where the ink actually is, hides the paper around it, and refits — so the type
gets bigger without you touching the zoom.

On Davidson's *Turbulence: An Introduction for Scientists and Engineers* (647
pages) the text block is 71.0% of the page width and 90.2% of its height, so
fitting the crop to the pane instead of the page gives **1.41× larger type, 98%
more ink on screen**.

That figure is for continuous scrolling fitted to the pane width. Reading a page
at a time fits the whole page instead — bound by height rather than width — which
on the same book is 1.11×. See [Settings](#settings).

---

## Install

Download the `.xpi` from the [latest release][releases], then in Zotero:
**Tools → Plugins → ⚙ → Install Add-on From File…**

Or build it yourself:

```sh
npm run build      # → build/crop-to-margin-<version>.xpi
```

Requires Zotero 7 or later. Developed against Zotero 9.0.6 (pdf.js 5.4.0).

[releases]: https://github.com/waelitani/crop-to-margin/releases

## Use

A crop button appears in the PDF reader's toolbar, next to the search icon.

- **Click it** and the open PDF is measured and cropped, right away.
- **It stays on.** The button is a global switch, not a per-document one: the
  next PDF you open is cropped as it loads, with no flash of uncropped page,
  because each document's crop is measured once and remembered.
- **Click it again** to turn cropping off, for this PDF and the next.

Right-clicking the page gives you the same toggle plus **Recalculate crop**, for
when a file has been replaced or you have changed the settings.

Everything else in the reader keeps working: text selection, highlighting,
annotations, search and thumbnails all land where they should, because the crop
is a clip over pdf.js rather than a change to the document.

## How it works

**Measure.** Sixteen pages, spread evenly through the document, are rendered off
screen at about 240 px wide and scanned for ink. The background level is the
render's modal luminance rather than a hard-coded white, so cream-coloured scans
and tinted pages measure correctly, and a row or column has to carry two ink
pixels before it counts, which stops scanner speckle from pinning the box to the
paper's edge. Covers and end matter are skipped; successive samples alternate
recto and verso, because an evenly spaced walk with an even stride would
otherwise stay on one side of the book all the way through.

**Agree.** The sampled pages are grouped by the text block they share. A textbook
is mostly body — one layout repeated for hundreds of pages, with front matter,
chapter openers, plates and an index as minorities — so the biggest group is the
body, and that is the part worth fitting. The crop is the smallest margin the
body itself ever uses: within a single layout, the minimum is safe by
construction. Any *other* layout that a quarter of the sample also uses is folded
in, so a two-column appendix cannot be silently sliced. If nothing dominates, a
low percentile is used instead, which tolerates outliers rather than excluding
them.

**Mirror.** Books alternate their inner and outer margins. When the recto and
verso boxes differ by more than 2% of the page, left-hand and right-hand pages
get their own crops, then both are equalised to the same content width so pages
do not change size as you scroll. On Davidson that is the difference between
1.24× and 1.41×.

**Guard.** One crop cannot fit every page of a real book. Any page whose *text*
reaches outside the document's crop keeps as much of its own margin as it needs —
checked from the text layer as the page renders, so it costs nothing to look at.
The check can only ever crop less, never more, so it cannot cost a page any ink.

**Apply.** Each `.page` element in Zotero's pdf.js viewer is clipped to the
content box and given matching negative margins, so the cropped-away paper stops
taking up layout space and the next page moves up to meet it. The clip is written
in PDF points multiplied by pdf.js's own `--total-scale-factor`, so it follows
every zoom change for free. Then the viewer is zoomed with pdf.js's own
page-width arithmetic, divided by what survives the crop.

### Measured on the example book

`tools/analyze_margins.py` is a reference implementation of the same
measurement, so the arithmetic can be checked against a real file outside
Zotero. Run against every one of Davidson's 647 pages, using a crop derived from
just 16 samples:

```
  647 pages, 535.8 x 697.3 pt, 16 measured
  mirrored margins: yes
    odd: left 19.30%  right  9.71%  top  5.21%  bottom  4.89%
   even: left  9.71%  right 19.30%  top  5.21%  bottom  4.89%
  content: 71.0% of page width, 89.9% of page height
  fitting the crop to the pane instead of the page magnifies the text 1.41x

  body (pages 20-628): 593 of 606 keep all their ink (97.9%)
  whole file: 618 of 639 (96.7%)
```

The pages that do not fit are the cover and the two-column index — front and back
matter, not the body — and those are exactly what the per-page guard hands their
margins back to.

Measured again inside Zotero, against the same book, the plugin agrees with the
reference to within a third of a percent per side, in about a second:

```
probe: waiveXrays=function cloneInto=function exportFunction=function
       page.view=ok getViewport=function render=function
measured 16/16 sampled pages of 647 (0 failed)
measured 16 pages in 1077 ms → odd[L19.3% R9.7% T5.2% B4.6%]
                               even[L10.1% R18.9% T5.2% B4.6%]
scroll mode 0 -> paginated
fit scale=1.1867 pane=2048x1000 content=0.710w 0.902h whole=true
```

For other kinds of document the gain is smaller because the margins are already
tight: journal articles in the same library come out at 1.10× to 1.15×.

## Settings

**Edit → Settings → Crop to Margin.**

| Setting | Default | What it does |
| --- | --- | --- |
| Crop automatically when a PDF is opened | on | The same switch as the toolbar button |
| Crop left- and right-hand pages separately | on | Mirrored-margin books; off means one safe crop for both |
| Give a page its own margins back | on | The per-page guard |
| Margin kept around the text | 6 pt | Breathing room, so the type does not touch the pane edge |
| Pages measured per document | 16 | More is slower and rarely more accurate |
| Pages that must keep all their content | 85% | Only used when no layout dominates |
| Most that may be cropped from one side | 30% | A hard ceiling, whatever the measurements say |
| Scrolling while cropped | one page at a time | Or leave the document's own scrolling alone |
| Fit the cropped page to | pane width | Only applies when scrolling is left alone — turning the pages always fits whole |

Every crop measured is remembered, keyed by attachment, so a document is only
ever measured once; **Forget all** clears them. The whole set lives in one
preference and is capped at 300 entries.

## Development

```sh
npm run check      # syntax-check the plugin sources
npm test           # run the measurement tests against real fixture data
npm run build      # pack addon/ into build/*.xpi and refresh update.json
```

`test/consensus.test.mjs` loads the plugin's own source into a VM with a stubbed
`Zotero` and checks its output against the Python reference implementation, using
the real per-page measurements from Davidson as a fixture. No Zotero required.

To iterate against a live Zotero, point it at the working tree instead of
reinstalling: create a file named after the plugin ID in your Zotero profile's
`extensions/` directory containing the absolute path to `addon/`, then restart.

`crop-to-margin.log` in the Zotero data directory records what the plugin did on
the current session — how many readers it adopted, how many sampled pages
measured, the crop it agreed on, the scale it fitted. Turn it off with the
`logFile` preference.

One trap worth knowing if you fork this: load plugin subscripts with
`loadSubScriptWithOptions(..., { ignoreCache: true })`. The subscript loader
caches by URL, the URL is the plugin ID, and without it an upgraded plugin
silently keeps running the version loaded first that session.

```
├── addon/                     what gets packed into the .xpi
│   ├── bootstrap.js           Zotero plugin entry points
│   ├── manifest.json
│   ├── prefs.js               default preferences
│   ├── content/
│   │   ├── crop-to-margin.js  measurement, consensus and the crop itself
│   │   └── preferences.*      settings pane
│   └── locale/en-US/
├── scripts/build.mjs          dependency-free .xpi packer
├── test/                      measurement tests + fixture
└── tools/analyze_margins.py   reference implementation (PyMuPDF + NumPy)
```

## Known limits

- Only PDFs. EPUB and snapshot readers are left alone.
- Turning the pages costs magnification: a whole spread fitted to the screen is
  smaller than one page fitted to the width. It is the price of a page-at-a-time
  reader, since Zotero only turns a page when nothing scrolls inside it. Set
  **Scrolling while cropped → Leave it as it is** for the larger type.
- The space bar does not turn pages: pdf.js reserves it for a zoom value the crop
  cannot use. Arrow keys, Page Down and the toolbar all work.
- Zotero dispatches its toolbar hook once per reader document, so the button is
  injected by hand into readers that were already open when the plugin started.
  If a future Zotero re-renders that component, the injected node would be
  cleared; the event path would then put it back.
- Jumping to a page lands on the top of the *uncropped* page, so the text starts
  a little below the top of the pane. pdf.js measures from the page's real box.
- A page whose ink genuinely runs to the paper's edge — a full-bleed plate, a
  Springer chapter with a rights notice down the spine — has no margin to crop,
  and the whole document's gain drops accordingly.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with Zotero or the Corporation for Digital Scholarship.
