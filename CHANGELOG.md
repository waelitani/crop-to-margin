# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] — 2026-08-27

### Fixed
- Measurement never ran. `canvas.getContext()` was handed an options object built
  on the chrome side; a chrome object reaching the viewer's compartment is opaque
  and reading a member off it is denied, so every page measurement threw and the
  crop silently did nothing. Every options bag handed to the viewer is now built
  there. Same fix applied to the scroll listeners and the mutation observers.
- The button never appeared in a reader that was already open when the plugin
  started. Zotero dispatches `renderToolbar` from a dependency-array-less effect
  inside a `memo()`'d component handed one constant prop, so it fires exactly once
  per reader document — at mount — and a reader open at startup had already spent
  it. The button is now injected directly into the live toolbar as well. The same
  fact is what makes that safe: the effect's `replaceChildren()` never runs again
  either.
- A split pane opened after cropping was turned on stayed uncropped. The catch-up
  for it was written on the assumption that `renderToolbar` repeats, so it was
  dead code; a mutation observer on the second view container replaces it.
- Toggling the button applied the change twice — once directly and once through
  the preference observer that fires for every open reader.
- The button no longer claims to be on when the crop failed to attach.
- Losing one event-bus hook no longer silently abandons the rest, and a mutation
  observer keeps pages stamped if the bus cannot be reached at all.
- Shutdown removes the button and disconnects the observers, instead of leaving a
  live control that would re-enable a plugin that is no longer loaded.

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
