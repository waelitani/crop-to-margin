# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-08-27

### Added
- Turn the pages instead of scrolling through them while cropped. A cropped page
  sits in a smaller box than pdf.js measures it in, so continuous scrolling drifts
  against the layout; paginated scrolling puts one page — or one spread — in the
  viewer at a time and sidesteps it. Settings → **Scrolling while cropped**.

### Fixed
- Re-fit the zoom when the pane changes width without the window resizing, which
  is what happens when a sidebar collapses or a plugin such as Zotero Focused Mode
  hides the reader chrome. Observed on the viewer container rather than inferred
  from window resizes, and guarded against re-fitting on its own scrollbar changes.

## [0.1.0] — 2026-08-27

First release.

### Added
- Crop button in the PDF reader toolbar, and the same toggle plus **Recalculate
  crop** in the page context menu.
- Ink measurement over a spread of sampled pages, with a modal-luminance
  background estimate and a minimum-ink threshold per row and column.
- Consensus crop tuned to the document's body layout, with co-dominant layouts
  folded in and a low-percentile fallback when no layout dominates.
- Mirrored recto/verso margins detected and equalised to one content width.
- Per-page guard: a page whose text reaches outside the document's crop keeps
  the margin it needs.
- Crops remembered per attachment and reapplied on open, so a document is
  measured once.
- Settings pane with the measurement and fit parameters.
