/* Default preferences. Loaded by Zotero when the plugin is installed.
   Only boolean / string / integer values are supported, so every fraction
   below is expressed in percent or in PDF points. */

// Apply the crop automatically whenever a PDF is opened.
pref("extensions.zotero.crop-to-margin.enabled", true);

// Margin left around the detected content block, in PDF points (72 pt = 1 in).
pref("extensions.zotero.crop-to-margin.padding", 6);

// How many pages are rendered and measured to decide on one crop box.
pref("extensions.zotero.crop-to-margin.sampleCount", 16);

// Consensus percentile per side. 15 keeps the content of ~85% of pages.
pref("extensions.zotero.crop-to-margin.quantile", 15);

// Detect mirrored (recto/verso) margins and crop odd/even pages differently.
pref("extensions.zotero.crop-to-margin.mirrorMargins", true);

// Hard cap on how much of a page may be cropped away, per side, in percent.
pref("extensions.zotero.crop-to-margin.maxCrop", 30);

// "width" fits the cropped text block to the pane width, "page" fits it whole.
pref("extensions.zotero.crop-to-margin.fitMode", "width");

// "page" turns the pages one at a time while cropping, which keeps pdf.js's idea
// of where a page sits from drifting against the cropped layout. "keep" leaves
// whatever scrolling mode the document was already using.
pref("extensions.zotero.crop-to-margin.scrollMode", "page");

// The scrolling mode a document used before it was first cropped. Zotero saves
// the paginated mode with the document, so this is the only record of what to
// go back to. Managed by the plugin.
pref("extensions.zotero.crop-to-margin.restoreScrollMode", 0);

// Width in pixels each sampled page is rendered at before it is scanned.
pref("extensions.zotero.crop-to-margin.renderWidth", 240);

// A pixel counts as ink when it is this much darker than the page background.
pref("extensions.zotero.crop-to-margin.threshold", 12);

// Ink pixels a row/column needs before it is believed, to reject speckles.
pref("extensions.zotero.crop-to-margin.minInk", 2);

// Give a page back its own margins when its text reaches outside the crop
// chosen for the document — an index or a plate set wider than the body.
pref("extensions.zotero.crop-to-margin.guardPages", true);

// Remembered crop boxes, keyed by attachment. Managed by the plugin.
pref("extensions.zotero.crop-to-margin.cache", "{}");
pref("extensions.zotero.crop-to-margin.cacheLimit", 300);

// Verbose logging to the Zotero debug output.
pref("extensions.zotero.crop-to-margin.debug", false);

// Write what the plugin is doing to crop-to-margin.log in the Zotero data
// directory. The interesting failures here are silent ones inside a reader you
// cannot put a breakpoint in. One session per file, capped at 256 KB.
pref("extensions.zotero.crop-to-margin.logFile", true);
