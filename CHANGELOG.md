# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] — 2026-08-28

### Fixed
- **A tab could collect two or three crop icons.** `renderToolbar` appended a
  button every time Zotero dispatched it, on the assumption — written into the
  code as a comment — that it fires exactly once per reader document. A toolbar
  that re-mounts dispatches again, and another plugin rearranging the reader
  layout is enough to cause one. The tell was that a tab already open when the
  plugin started showed a single icon: that one is hand-injected and never
  dispatched to. Both routes into the toolbar now clear any crop button they
  find before adding their own.
- Buttons left behind by the previous version after an upgrade are now replaced
  rather than adopted. Their click handlers close over a `CropToMargin` that
  `shutdown()` has already retired, so an adopted one looked fine and did
  nothing.
- `ensureButton` searched one container for an existing button while the other
  route resolved its container separately — a button it could not see was a
  button it would duplicate. It now looks at the whole document.

### Changed
- A release now carries the `.xpi` under two names: the versioned one that
  `update.json` pins by `sha256`, and a constant `crop-to-margin.xpi`, so
  `releases/latest/download/crop-to-margin.xpi` is a link that never goes stale.

## [0.1.7] — 2026-08-27

### Changed
- The log file is off by default. It was bring-up instrumentation and the plugin
  now works; set the `logFile` preference to turn it back on. Errors still reach
  Zotero's own debug output either way.

## [0.1.6] — 2026-08-27

### Fixed
- **Upgrading the plugin did nothing.** `bootstrap.js` loaded the plugin's code
  with `loadSubScript`, which caches compiled scripts by URL for the life of the
  process — and the URL is the plugin's ID, which does not change between
  versions. So installing a new version into a running Zotero silently re-ran
  whichever version had been loaded first that session. Every fix from 0.1.1
  onwards was shadowed. Zotero loads `bootstrap.js` itself with
  `ignoreCache: true` for exactly this reason; now so does the plugin.
- A pane that was not laid out yet — a background tab measuring 0×0 — left the
  fit permanently owed: the early return happened before a scale was recorded,
  and the retry path only ran once one had been. It now leaves a note to come
  back.
- The toolbar button could report "on" after an attach that had returned early
  and done nothing.
- "No measurable content" covered two different outcomes — nothing measured, and
  everything measured but discarded as blank. They now say which.

## [0.1.5] — 2026-08-27

### Fixed
- Nothing was ever measured, on any document. Chrome sees the reader's objects
  through Xray wrappers, which expose own data properties but hide anything
  reached through the prototype — so pdf.js's `page.view` getter read as
  `undefined` rather than throwing, every page measurement failed on the first
  line, and the crop had nothing to work from. Assigning one content object onto
  another was refused for the same reason. Both sides of that boundary are now
  waived. The waiver is sticky through property reads but not across an `await`,
  so everything a content promise hands back is waived again.
- The reader adoption poll logged its failure five times a second for a minute.

### Added
- A one-line capability probe in the log, recording what this build of Zotero
  actually permits. Reaching into the viewer is the fragile part of this plugin.

## [0.1.4] — 2026-08-27

### Added
- A log beside the library, at `crop-to-margin.log` in the Zotero data directory.
  The failures that matter here are silent ones inside a reader that cannot be
  breakpointed, and every early return on the path from opening a PDF to applying
  a crop now says so. One session per file, capped at 256 KB, switchable off with
  the `logFile` preference.

### Fixed
- A page that could not be measured was reported only under the `debug`
  preference, so a document that measured nothing at all looked identical to one
  that needed no crop.

## [0.1.3] — 2026-08-27

Paginated scrolling shipped in 0.1.1 was broken in ways an audit against pdf.js
5.4.0 caught before much reading was done with it.

### Fixed
- **Pages could not be turned.** pdf.js turns a page on ArrowDown or PageDown only
  when the relevant scrollbar is absent, or when the zoom is literally the string
  `page-fit` — and the crop's zoom is always a number. Paired with a fit-to-width
  zoom that left the page scrolling, a reader reached the bottom of a page with no
  way forward. Paginated mode now fits each page whole, whatever the fit
  preference says.
- **A spread lost its right-hand page.** The scrollbar suppression measured one
  page, not the two-page row plus its gap, so it hid the scrollbar while half the
  spread sat outside the pane with no way to reach it.
- **The zoom could oscillate.** The pane width was recorded before the zoom was
  applied rather than after, so the scrollbar arriving or leaving read as an
  external resize and re-fitted, frame after frame.
- **The document's scrolling mode was destroyed after one session.** Zotero saves
  the mode with the document, so on the second open the viewer was already
  paginated and there was nothing left in it to remember. What to go back to is
  now kept outside the viewer.
- Page turns no longer leave the spread shoved sideways: `overflow-x: hidden`
  still scrolls programmatically, and pdf.js sets the offset from the page's real
  edge, which the crop put a margin's width outside the pane.
- A whole-page fit now answers a pane that gets taller without getting wider —
  which is exactly what hiding the reader chrome does.
- A reader in a background tab measures 0×0; fitting to that pegged the zoom at
  its minimum and flashed when the tab came back.
- Resize deliveries are coalesced, so a full-screen transition no longer forces a
  relayout for each intermediate size.
- Observers are disconnected before anything that can throw on a torn-down view,
  instead of after; and the per-page stamps are cleared through the page views,
  since paginated mode keeps all but the current page out of the DOM.

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
