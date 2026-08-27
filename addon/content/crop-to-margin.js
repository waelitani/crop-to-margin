/* Crop to Margin — Zotero plugin
 *
 * Measures where the ink actually is on a PDF's pages, then hides the paper
 * around it and zooms in so the text block fills the reader pane.
 *
 * The crop is CSS layered onto Zotero's bundled pdf.js viewer: every `.page`
 * element is clipped to the content box and given matching negative margins,
 * so the cropped-away paper stops taking up layout space. The clip is written
 * in PDF points scaled by pdf.js's own `--total-scale-factor`, so it follows
 * every zoom change without being recomputed, and because the canvas, text and
 * annotation layers are all children of `.page`, they stay pinned to the text
 * they belong to.
 */

var CropToMargin = {
	PREF: 'extensions.zotero.crop-to-margin.',
	STYLE_ID: 'crop-to-margin-style',
	VIEWER_CLASS: 'ctm-active',
	FIT_CLASS: 'ctm-fit',
	CACHE_VERSION: 1,

	// pdf.js constants, mirrored so our fitted scale matches "page width" exactly.
	SCROLLBAR_PADDING: 40,
	VERTICAL_PADDING: 5,
	VIEWER_PADDING: 36,
	MIN_SCALE: 0.1,
	MAX_SCALE: 10,
	SCROLL_MODE_HORIZONTAL: 1,
	SPREAD_MODE_NONE: 0,

	DEFAULTS: {
		enabled: true,
		padding: 6,
		sampleCount: 16,
		quantile: 15,
		mirrorMargins: true,
		maxCrop: 30,
		fitMode: 'width',
		renderWidth: 240,
		threshold: 12,
		minInk: 2,
		guardPages: true,
		cache: '{}',
		cacheLimit: 300,
		debug: false
	},

	id: null,
	version: null,
	rootURI: null,

	_l10n: null,
	_prefObserver: null,
	_prefPaneID: null,
	_hooked: null,
	_states: null,

	/* ---------------------------------------------------------------- setup */

	async init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this._hooked = new WeakSet();
		this._states = new WeakMap();

		try {
			this._l10n = new Localization(['crop-to-margin.ftl'], true);
		}
		catch (e) {
			this._l10n = null;
		}

		Zotero.Reader.registerEventListener('renderToolbar', this._onRenderToolbar, id);
		Zotero.Reader.registerEventListener('createViewContextMenu', this._onViewContextMenu, id);

		this._prefObserver = Zotero.Prefs.registerObserver(
			this.PREF + 'enabled',
			() => this._onEnabledChanged(),
			true
		);

		try {
			this._prefPaneID = await Zotero.PreferencePanes.register({
				pluginID: id,
				src: rootURI + 'content/preferences.xhtml',
				scripts: [rootURI + 'content/preferences.js'],
				stylesheets: [rootURI + 'content/preferences.css'],
				image: rootURI + 'content/icons/crop-to-margin.svg',
				label: 'Crop to Margin'
			});
		}
		catch (e) {
			this.logError(e);
		}

		// Readers that were already open when the plugin started.
		for (let reader of this.readers()) {
			this.hookReader(reader);
		}
		this.log('initialized ' + version);
	},

	shutdown() {
		// Zotero.Reader.unregisterEventListener() has an inverted filter and would
		// drop every *other* plugin's listeners, so leave that cleanup to
		// Zotero.Reader's own per-plugin shutdown observer. Same for the pref pane.
		if (this._prefObserver) {
			try {
				Zotero.Prefs.unregisterObserver(this._prefObserver);
			}
			catch (e) {
				this.logError(e);
			}
			this._prefObserver = null;
		}
		for (let reader of this.readers()) {
			try {
				this.disable(reader);
			}
			catch (e) {
				this.logError(e);
			}
		}
		this._hooked = new WeakSet();
		this._states = new WeakMap();
		this._l10n = null;
	},

	/* ------------------------------------------------------------ utilities */

	log(msg) {
		Zotero.debug('[crop-to-margin] ' + msg);
	},

	logError(e) {
		Zotero.logError(new Error('[crop-to-margin] ' + (e && e.message ? e.message : e)));
		if (e && e.stack) Zotero.debug(e.stack);
	},

	trace(msg) {
		if (this.getPref('debug')) this.log(msg);
	},

	getPref(key) {
		let value;
		try {
			value = Zotero.Prefs.get(this.PREF + key, true);
		}
		catch (e) {
			value = undefined;
		}
		return value === undefined ? this.DEFAULTS[key] : value;
	},

	setPref(key, value) {
		Zotero.Prefs.set(this.PREF + key, value, true);
	},

	getString(name, fallback) {
		try {
			let value = this._l10n && this._l10n.formatValueSync(name);
			if (value) return value;
		}
		catch (e) {
			// No Fluent bundle in this context; fall through.
		}
		return fallback;
	},

	clamp(value, min, max) {
		if (!Number.isFinite(value)) return min;
		return Math.min(max, Math.max(min, value));
	},

	delay(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	},

	/**
	 * An object inside the viewer's compartment. pdf.js runs as content and is not
	 * allowed to read an object we made here, so arguments have to be built there.
	 */
	contentObj(win, props) {
		let obj = null;
		for (let make of [
			() => new win.Object(),
			() => win.JSON.parse('{}'),
			() => Components.utils.cloneInto({}, win)
		]) {
			try {
				obj = make();
				if (obj) break;
			}
			catch (e) {
				// Try the next way in.
			}
		}
		if (!obj) throw new Error('cannot reach the viewer compartment');
		for (let key of Object.keys(props)) {
			obj[key] = props[key];
		}
		return obj;
	},

	/** A callable version of a chrome function for pdf.js's plain-JS event bus. */
	exportFn(win, fn) {
		try {
			return Components.utils.exportFunction(fn, win);
		}
		catch (e) {
			return null;
		}
	},

	readers() {
		return (Zotero.Reader && Zotero.Reader._readers) || [];
	},

	/* ------------------------------------------------------- reader plumbing */

	/** Every PDF view of a reader — primary plus the split pane, when open. */
	getViews(reader) {
		let internal = reader && reader._internalReader;
		if (!internal) return [];
		return [internal._primaryView, internal._secondaryView].filter((view) => {
			try {
				return !!(view && view._iframeWindow && view._iframeWindow.PDFViewerApplication);
			}
			catch (e) {
				return false;
			}
		});
	},

	stateFor(reader) {
		let state = this._states.get(reader);
		if (!state) {
			state = { active: false, busy: false, crop: null, views: new WeakMap(), button: null };
			this._states.set(reader, state);
		}
		return state;
	},

	hookReader(reader) {
		if (!reader || reader.type !== 'pdf') return;
		if (this._hooked.has(reader)) return;
		this._hooked.add(reader);
		if (!this.getPref('enabled')) return;
		this.waitForDocument(reader)
			.then(ready => ready && this.enable(reader))
			.catch(e => this.logError(e));
	},

	/** Resolves once the primary view has a loaded PDF document and settled. */
	async waitForDocument(reader, timeoutMS = 120000) {
		let deadline = Date.now() + timeoutMS;
		let watching = null;
		let initialized = false;
		while (Date.now() < deadline) {
			if (!this.readers().includes(reader)) return false;
			let views = this.getViews(reader);
			if (views.length) {
				// initializedPromise resolves once Zotero has restored the document's
				// saved zoom and position, so our own fit is not applied only to be
				// overwritten a moment later. Watched rather than awaited, so a view
				// that never finishes coming up cannot wedge us here.
				if (!watching) {
					watching = Promise.resolve(views[0].initializedPromise)
						.then(() => { initialized = true; }, () => { initialized = true; });
				}
				let app = views[0]._iframeWindow.PDFViewerApplication;
				if (initialized && app.pdfDocument && app.pdfViewer && app.pdfViewer.pagesCount) {
					return true;
				}
			}
			await this.delay(150);
		}
		return false;
	},

	/* ------------------------------------------------------------- toolbar UI */

	_onRenderToolbar(event) {
		try {
			CropToMargin.renderToolbar(event);
		}
		catch (e) {
			CropToMargin.logError(e);
		}
	},

	renderToolbar(event) {
		let { reader, doc, append } = event;
		if (!reader || reader.type !== 'pdf') return;

		this.hookReader(reader);
		let state = this.stateFor(reader);

		// A split pane can appear after the crop was applied; this event fires on
		// every toolbar render, so it is the cheapest place to catch it up.
		if (state.active && state.crop) {
			for (let view of this.getViews(reader)) {
				if (!state.views.has(view)) this.attachView(state, view, state.crop);
			}
		}

		let button = doc.createElement('button');
		button.className = 'toolbar-button' + (state.active ? ' active' : '');
		button.setAttribute('tabindex', '-1');
		button.setAttribute('aria-pressed', state.active ? 'true' : 'false');
		button.title = this.buttonTitle(state);
		if (state.busy) button.setAttribute('disabled', 'true');
		button.appendChild(this.createIcon(doc));
		button.addEventListener('click', () => {
			this.toggle(reader).catch(e => this.logError(e));
		});

		state.button = button;
		append(button);
	},

	buttonTitle(state) {
		return state.active
			? this.getString('crop-to-margin-button-title-on', 'Crop to margin (on)')
			: this.getString('crop-to-margin-button-title', 'Crop to margin');
	},

	createIcon(doc) {
		const NS = 'http://www.w3.org/2000/svg';
		let svg = doc.createElementNS(NS, 'svg');
		svg.setAttribute('width', '20');
		svg.setAttribute('height', '20');
		svg.setAttribute('viewBox', '0 0 20 20');
		svg.setAttribute('fill', 'none');
		let path = doc.createElementNS(NS, 'path');
		path.setAttribute('fill', 'currentColor');
		path.setAttribute('fill-rule', 'evenodd');
		path.setAttribute('d', 'M5 1h1.5v18H5V1zm-4 12.5h18V15H1v-1.5zM6.5 5h8v1.5h-8V5zM13 6.5h1.5v7H13v-7z');
		svg.appendChild(path);
		return svg;
	},

	/** Update the button already in the DOM, without waiting for a React render. */
	syncButton(reader) {
		let state = this._states.get(reader);
		let button = state && state.button;
		if (!button) return;
		try {
			button.classList.toggle('active', !!state.active);
			button.setAttribute('aria-pressed', state.active ? 'true' : 'false');
			button.title = this.buttonTitle(state);
			if (state.busy) button.setAttribute('disabled', 'true');
			else button.removeAttribute('disabled');
		}
		catch (e) {
			// Button belongs to a torn-down document.
		}
	},

	_onViewContextMenu(event) {
		try {
			let { reader, append } = event;
			if (!reader || reader.type !== 'pdf') return;
			let state = CropToMargin.stateFor(reader);
			append({
				label: CropToMargin.getString('crop-to-margin-menu-toggle', 'Crop to margin'),
				checked: state.active,
				onCommand: () => CropToMargin.toggle(reader).catch(e => CropToMargin.logError(e))
			}, {
				label: CropToMargin.getString('crop-to-margin-menu-recalculate', 'Recalculate crop'),
				disabled: state.busy,
				onCommand: () => CropToMargin.enable(reader, { recalculate: true })
					.catch(e => CropToMargin.logError(e))
			});
		}
		catch (e) {
			CropToMargin.logError(e);
		}
	},

	/* ------------------------------------------------------------ on and off */

	/**
	 * The toolbar button is the global switch: whatever it is left at is what the
	 * next PDF opens with.
	 */
	async toggle(reader) {
		let state = this.stateFor(reader);
		if (state.busy) return;
		let next = !state.active;
		if (this.getPref('enabled') !== next) this.setPref('enabled', next);
		if (next) await this.enable(reader);
		else this.disable(reader);
	},

	_onEnabledChanged() {
		let enabled = this.getPref('enabled');
		for (let reader of this.readers()) {
			if (!reader || reader.type !== 'pdf') continue;
			if (enabled) {
				this.waitForDocument(reader)
					.then(ready => ready && this.enable(reader))
					.catch(e => this.logError(e));
			}
			else {
				try {
					this.disable(reader);
				}
				catch (e) {
					this.logError(e);
				}
			}
		}
	},

	async enable(reader, { recalculate = false } = {}) {
		let state = this.stateFor(reader);
		if (state.busy) return;
		let views = this.getViews(reader);
		if (!views.length) return;

		state.busy = true;
		this.syncButton(reader);
		try {
			let crop = recalculate ? null : this.loadCached(reader, views[0]);
			if (crop) {
				this.trace('using remembered crop for item ' + reader.itemID);
			}
			else {
				let started = Date.now();
				crop = await this.computeCrop(views[0]);
				if (!crop) {
					this.log('no measurable content; leaving item ' + reader.itemID + ' uncropped');
					return;
				}
				this.log('measured ' + crop.samples + ' pages of item ' + reader.itemID
					+ ' in ' + (Date.now() - started) + ' ms → ' + this.describe(crop));
				this.saveCached(reader, crop);
			}

			state.crop = crop;
			state.active = true;
			for (let view of this.getViews(reader)) {
				this.attachView(state, view, crop);
			}
		}
		finally {
			state.busy = false;
			this.syncButton(reader);
		}
	},

	disable(reader) {
		let state = this._states.get(reader);
		if (!state) return;
		for (let view of this.getViews(reader)) {
			this.detachView(state, view);
		}
		state.active = false;
		this.syncButton(reader);
	},

	describe(crop) {
		let pct = v => (v * 100).toFixed(1) + '%';
		let side = c => 'L' + pct(c.l) + ' R' + pct(c.r) + ' T' + pct(c.t) + ' B' + pct(c.b);
		return crop.mirrored
			? 'odd[' + side(crop.odd) + '] even[' + side(crop.even) + ']'
			: side(crop.odd);
	},

	/* --------------------------------------------------------- measuring ink */

	/**
	 * Render a spread of pages small, find the ink on each, agree on one box.
	 * @returns {Promise<Object|null>} Crop fractions of the *unrotated* page box.
	 */
	async computeCrop(view) {
		let win = view._iframeWindow;
		let pdf = win.PDFViewerApplication.pdfDocument;
		let numPages = pdf.numPages;
		if (!numPages) return null;

		let options = {
			renderWidth: this.clamp(this.getPref('renderWidth'), 80, 1000),
			threshold: this.clamp(this.getPref('threshold'), 1, 128),
			minInk: this.clamp(this.getPref('minInk'), 1, 64)
		};
		let indexes = this.pickPages(numPages, this.clamp(this.getPref('sampleCount'), 3, 64));

		let samples = [];
		for (let index of indexes) {
			let sample;
			try {
				sample = await this.measurePage(win, pdf, index, options);
			}
			catch (e) {
				this.trace('page ' + (index + 1) + ' could not be measured: ' + e);
				continue;
			}
			if (sample) samples.push(sample);
		}
		if (samples.length < 2) return null;
		return this.consensus(samples, numPages);
	},

	/**
	 * Evenly spaced page indexes, skipping the covers and end matter of a long
	 * document — those have margins nothing else in the book shares.
	 *
	 * Successive picks are nudged onto alternating recto/verso pages. An evenly
	 * spaced walk with an even stride would otherwise land on one side of the
	 * book for the whole document, and mirrored margins would go undetected.
	 */
	pickPages(numPages, count) {
		let first = 0;
		let last = numPages - 1;
		if (numPages > 20) {
			first = Math.floor(numPages * 0.03);
			last = Math.ceil(numPages * 0.97) - 1;
		}
		let span = last - first;
		let n = Math.min(count, span + 1);
		let seen = new Set();
		let indexes = [];
		for (let i = 0; i < n; i++) {
			let index = n === 1 ? first : first + Math.round((i * span) / (n - 1));
			if ((index + 1) % 2 !== i % 2) index += (index < last) ? 1 : -1;
			index = this.clamp(index, first, last);
			if (!seen.has(index)) {
				seen.add(index);
				indexes.push(index);
			}
		}
		return indexes;
	},

	async measurePage(win, pdf, index, { renderWidth, threshold, minInk }) {
		let page = await pdf.getPage(index + 1);
		let canvas = null;
		try {
			let box = page.view;
			let pageWidth = box[2] - box[0];
			let pageHeight = box[3] - box[1];
			if (!(pageWidth > 0) || !(pageHeight > 0)) return null;

			// Measured unrotated; display rotation is applied when the crop is
			// stamped onto the page elements.
			let viewport = page.getViewport(this.contentObj(win, {
				scale: renderWidth / pageWidth,
				rotation: 0
			}));
			let width = Math.max(1, Math.round(viewport.width));
			let height = Math.max(1, Math.round(viewport.height));

			canvas = win.document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			let ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, width, height);
			await page.render(this.contentObj(win, { canvasContext: ctx, viewport })).promise;

			let ink = this.inkBox(ctx.getImageData(0, 0, width, height), threshold, minInk);
			if (!ink) return null;

			return {
				index,
				pageWidth,
				pageHeight,
				l: ink.x0 / width,
				r: 1 - ink.x1 / width,
				t: ink.y0 / height,
				b: 1 - ink.y1 / height,
				area: ((ink.x1 - ink.x0) * (ink.y1 - ink.y0)) / (width * height)
			};
		}
		finally {
			if (canvas) {
				// Frees the graphics buffer immediately (the trick pdf.js uses).
				canvas.width = 0;
				canvas.height = 0;
			}
		}
	},

	/**
	 * Bounding box of everything that is not page background.
	 *
	 * The background level is the modal luminance of the render rather than a
	 * fixed white, so cream-coloured scans and tinted pages measure correctly.
	 * A row or column has to carry `minInk` pixels before it counts, which keeps
	 * scanner speckle from pinning the box to the paper edge.
	 */
	inkBox(imageData, threshold, minInk) {
		let width = imageData.width;
		let height = imageData.height;
		let source = imageData.data;
		let data;
		try {
			data = new Uint8ClampedArray(source.length);
			data.set(source);
		}
		catch (e) {
			data = source;
		}

		let luminance = new Uint8Array(width * height);
		let histogram = new Uint32Array(256);
		for (let i = 0, p = 0; p < luminance.length; p++, i += 4) {
			let value = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0;
			luminance[p] = value;
			histogram[value]++;
		}
		let background = 0;
		for (let value = 1; value < 256; value++) {
			if (histogram[value] > histogram[background]) background = value;
		}

		let rowInk = new Uint32Array(height);
		let colInk = new Uint32Array(width);
		for (let y = 0, p = 0; y < height; y++) {
			for (let x = 0; x < width; x++, p++) {
				if (Math.abs(luminance[p] - background) > threshold) {
					rowInk[y]++;
					colInk[x]++;
				}
			}
		}

		let bounds = (counts) => {
			let lo = -1;
			let hi = -1;
			for (let i = 0; i < counts.length; i++) {
				if (counts[i] >= minInk) {
					if (lo === -1) lo = i;
					hi = i;
				}
			}
			return lo === -1 ? null : [lo, hi + 1];
		};
		let vertical = bounds(rowInk);
		let horizontal = bounds(colInk);
		if (!vertical || !horizontal) return null;
		return { x0: horizontal[0], x1: horizontal[1], y0: vertical[0], y1: vertical[1] };
	},

	/**
	 * Sampled pages grouped by the text block they share, biggest group first.
	 *
	 * A textbook is mostly body: one layout repeated for hundreds of pages, with
	 * front matter, chapter openers, plates and an index as minorities. Binning
	 * the left/right insets separates that body layout from the rest, and the
	 * body is the part worth reading and therefore the part worth fitting.
	 */
	clusters(samples, binSize = 0.01) {
		let groups = new Map();
		for (let sample of samples) {
			let key = Math.round(sample.l / binSize) + ':' + Math.round(sample.r / binSize);
			let group = groups.get(key);
			if (!group) groups.set(key, group = []);
			group.push(sample);
		}
		return [...groups.values()].sort((a, b) => b.length - a.length);
	},

	/**
	 * Insets of the body layout: the smallest margin the body itself ever uses.
	 *
	 * Within one layout the minimum is the safe crop — it is set by the page whose
	 * ink reaches furthest. Any *other* layout a quarter of the sample also uses
	 * is folded in, because a crop that clips a third of the document is not a
	 * consensus; rarer layouts are left to guardPage(). When nothing dominates at
	 * all we fall back to a low percentile, which tolerates outliers rather than
	 * excluding them.
	 */
	bodyInsets(samples, quantile) {
		let groups = this.clusters(samples);
		let dominant = Math.max(3, Math.ceil(samples.length * 0.4));
		if (groups.length && groups[0].length >= dominant) {
			let common = Math.max(2, Math.ceil(samples.length * 0.25));
			let members = [];
			for (let i = 0; i < groups.length; i++) {
				if (i === 0 || groups[i].length >= common) members.push(...groups[i]);
			}
			return {
				l: Math.min(...members.map(s => s.l)),
				r: Math.min(...members.map(s => s.r)),
				t: Math.min(...members.map(s => s.t)),
				b: Math.min(...members.map(s => s.b)),
				pages: members.length,
				clustered: true
			};
		}
		return {
			l: this.percentile(samples.map(s => s.l), quantile),
			r: this.percentile(samples.map(s => s.r), quantile),
			t: this.percentile(samples.map(s => s.t), quantile),
			b: this.percentile(samples.map(s => s.b), quantile),
			pages: samples.length,
			clustered: false
		};
	},

	/**
	 * One crop box for the whole document, tuned to the body.
	 *
	 * Books printed with mirrored margins get a recto box and a verso box,
	 * equalised to the same content width so pages do not change size as you
	 * scroll. Pages that set type outside the result — an index, a plate — are
	 * caught later, one at a time, by guardPage().
	 */
	consensus(samples, numPages) {
		let quantile = this.clamp(this.getPref('quantile'), 0, 50) / 100;
		let maxCrop = this.clamp(this.getPref('maxCrop'), 0, 45) / 100;
		let paddingPts = this.clamp(this.getPref('padding'), 0, 144);
		let mirrorMargins = !!this.getPref('mirrorMargins');

		let usable = samples.filter(s => s.area >= 0.005);
		if (usable.length < 2) return null;

		let pageWidth = this.median(usable.map(s => s.pageWidth));
		let pageHeight = this.median(usable.map(s => s.pageHeight));
		let padX = pageWidth > 0 ? paddingPts / pageWidth : 0;
		let padY = pageHeight > 0 ? paddingPts / pageHeight : 0;
		let trim = (value, pad) => this.clamp(value - pad, 0, maxCrop);

		let odd = usable.filter(s => (s.index + 1) % 2 === 1);
		let even = usable.filter(s => (s.index + 1) % 2 === 0);

		let mirrored = false;
		let oddBody, evenBody;
		if (mirrorMargins && odd.length >= 3 && even.length >= 3) {
			oddBody = this.bodyInsets(odd, quantile);
			evenBody = this.bodyInsets(even, quantile);
			mirrored = Math.abs(oddBody.l - evenBody.l) > 0.02
				|| Math.abs(oddBody.r - evenBody.r) > 0.02;
		}
		if (!mirrored) {
			oddBody = evenBody = this.bodyInsets(usable, quantile);
		}

		let horizontal = {
			odd: { l: trim(oddBody.l, padX), r: trim(oddBody.r, padX) },
			even: { l: trim(evenBody.l, padX), r: trim(evenBody.r, padX) }
		};
		// One vertical crop for both sides, so facing pages stay the same height.
		let top = trim(Math.min(oddBody.t, evenBody.t), padY);
		let bottom = trim(Math.min(oddBody.b, evenBody.b), padY);

		// Same content width on every page, so scrolling does not resize the text.
		let total = Math.min(
			horizontal.odd.l + horizontal.odd.r,
			horizontal.even.l + horizontal.even.r
		);
		for (let key of ['odd', 'even']) {
			let side = horizontal[key];
			let sum = side.l + side.r;
			if (sum > total && sum > 0) {
				let k = total / sum;
				side.l *= k;
				side.r *= k;
			}
		}

		// Never crop a page down to a sliver, whatever the measurements say.
		const MIN_CONTENT = 0.4;
		let vertical = this.shrinkToFit(top, bottom, MIN_CONTENT);
		for (let key of ['odd', 'even']) {
			let side = horizontal[key];
			let fitted = this.shrinkToFit(side.l, side.r, MIN_CONTENT);
			side.l = fitted[0];
			side.r = fitted[1];
		}

		let crop = {
			version: this.CACHE_VERSION,
			pages: numPages,
			samples: usable.length,
			bodyPages: oddBody.pages + (mirrored ? evenBody.pages : 0),
			clustered: oddBody.clustered,
			pageWidth,
			pageHeight,
			mirrored,
			odd: { l: horizontal.odd.l, r: horizontal.odd.r, t: vertical[0], b: vertical[1] },
			even: { l: horizontal.even.l, r: horizontal.even.r, t: vertical[0], b: vertical[1] }
		};
		crop.trivial = (crop.odd.l + crop.odd.r) < 0.01 && (crop.odd.t + crop.odd.b) < 0.01;
		return crop;
	},

	shrinkToFit(a, b, minContent) {
		let sum = a + b;
		let maxSum = 1 - minContent;
		if (sum <= maxSum || sum <= 0) return [a, b];
		let k = maxSum / sum;
		return [a * k, b * k];
	},

	median(values) {
		return this.percentile(values, 0.5);
	},

	percentile(values, p) {
		let sorted = values.slice().sort((a, b) => a - b);
		if (!sorted.length) return 0;
		let position = p * (sorted.length - 1);
		let low = Math.floor(position);
		let high = Math.min(low + 1, sorted.length - 1);
		return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
	},

	/* ----------------------------------------------------------- persistence */

	cacheKey(reader) {
		let item = Zotero.Items.get(reader.itemID);
		if (!item) return null;
		return item.libraryID + '/' + item.key;
	},

	readCache() {
		try {
			let parsed = JSON.parse(this.getPref('cache') || '{}');
			return (parsed && typeof parsed === 'object') ? parsed : {};
		}
		catch (e) {
			return {};
		}
	},

	loadCached(reader, view) {
		let key = this.cacheKey(reader);
		if (!key) return null;
		let entry = this.readCache()[key];
		if (!entry || entry.version !== this.CACHE_VERSION) return null;
		// A replaced or re-downloaded file invalidates the measurement.
		let numPages = view._iframeWindow.PDFViewerApplication.pdfDocument.numPages;
		if (entry.pages !== numPages) return null;
		return entry;
	},

	saveCached(reader, crop) {
		let key = this.cacheKey(reader);
		if (!key) return;
		let cache = this.readCache();
		cache[key] = Object.assign({}, crop, { ts: Date.now() });

		let limit = this.clamp(this.getPref('cacheLimit'), 10, 10000);
		let keys = Object.keys(cache);
		if (keys.length > limit) {
			keys.sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0));
			for (let stale of keys.slice(0, keys.length - limit)) delete cache[stale];
		}
		this.setPref('cache', JSON.stringify(cache));
	},

	clearCache() {
		this.setPref('cache', '{}');
	},

	/* ----------------------------------------------------------- applying it */

	css() {
		// --ctm-{t,r,b,l} are stamped per page, in PDF points, already rotated into
		// display orientation. --total-scale-factor is pdf.js's own points-to-px
		// factor, so the crop tracks every zoom without being recomputed.
		//
		// The clip hides the paper; the negative margins take it out of the layout
		// so the next page moves up and the flex centring re-centres what is left.
		// Clipped-away paper still counts towards the scroll width, so while the
		// cropped page fits the pane we suppress the horizontal scrollbar it would
		// otherwise leave behind.
		return [
			'#viewer.' + this.VIEWER_CLASS + ' .page {',
			'\t--ctm-t: 0; --ctm-r: 0; --ctm-b: 0; --ctm-l: 0;',
			'\t--ctm-tpx: calc(var(--total-scale-factor) * var(--ctm-t) * 1px);',
			'\t--ctm-rpx: calc(var(--total-scale-factor) * var(--ctm-r) * 1px);',
			'\t--ctm-bpx: calc(var(--total-scale-factor) * var(--ctm-b) * 1px);',
			'\t--ctm-lpx: calc(var(--total-scale-factor) * var(--ctm-l) * 1px);',
			'\tclip-path: inset(var(--ctm-tpx) var(--ctm-rpx) var(--ctm-bpx) var(--ctm-lpx));',
			'\tmargin-top: calc(-1 * var(--ctm-tpx));',
			'\tmargin-right: calc(-1 * var(--ctm-rpx));',
			'\tmargin-bottom: calc(-1 * var(--ctm-bpx));',
			'\tmargin-left: calc(-1 * var(--ctm-lpx));',
			'}',
			'body.' + this.FIT_CLASS + ' #viewerContainer {',
			'\toverflow-x: hidden;',
			'}'
		].join('\n');
	},

	attachView(state, view, crop) {
		let win = view._iframeWindow;
		let doc = win.document;
		let app = win.PDFViewerApplication;
		let viewer = app.pdfViewer;
		let viewerEl = doc.getElementById('viewer');
		if (!viewerEl) return;

		let entry = state.views.get(view);
		if (!entry) {
			entry = {
				previousScaleValue: viewer.currentScaleValue,
				appliedScale: null,
				style: null,
				busEvents: [],
				domEvents: [],
				pending: null,
				checked: new Set(),
				pageBoxes: new Map()
			};
			state.views.set(view, entry);
		}
		if (entry.crop !== crop) {
			entry.checked.clear();
			entry.pageBoxes.clear();
		}
		entry.crop = crop;

		let style = doc.getElementById(this.STYLE_ID);
		if (!style) {
			style = doc.createElement('style');
			style.id = this.STYLE_ID;
			doc.head.appendChild(style);
		}
		style.textContent = this.css();
		entry.style = style;
		viewerEl.classList.add(this.VIEWER_CLASS);

		this.stampAll(state, view);

		if (!entry.busEvents.length) {
			// pdf.js's event bus is plain JS, so a chrome callback has to be
			// exported into the viewer before it can be called from there.
			let handlers = {
				pagesinit: () => this.stampAll(state, view),
				pagesloaded: () => this.stampAll(state, view),
				pagerendered: (e) => this.onPageRendered(state, view, (e && e.pageNumber || 1) - 1),
				rotationchanging: () => this.reapply(state, view),
				spreadmodechanged: () => this.reapply(state, view),
				scrollmodechanged: () => this.reapply(state, view)
			};
			for (let name of Object.keys(handlers)) {
				let exported = this.exportFn(win, handlers[name]);
				if (!exported) break;
				app.eventBus.on(name, exported);
				entry.busEvents.push([name, exported]);
			}
		}
		if (!entry.domEvents.length) {
			// DOM listeners work from chrome without being exported, and cover the
			// cases the event bus would have covered if exportFunction were missing.
			let container = doc.getElementById('viewerContainer');
			let onResize = () => this.refit(state, view);
			let onSettle = () => this.scheduleFitClass(state, view);
			win.addEventListener('resize', onResize);
			entry.domEvents.push([win, 'resize', onResize]);
			if (container) {
				for (let name of ['wheel', 'scroll']) {
					container.addEventListener(name, onSettle, { passive: true });
					entry.domEvents.push([container, name, onSettle]);
				}
			}
		}

		this.fit(state, view);
		// The page on screen is the one worth guarding first.
		this.guardPage(state, view, Math.max(0, viewer.currentPageNumber - 1))
			.catch(e => this.logError(e));
	},

	detachView(state, view) {
		let entry = state.views.get(view);
		if (!entry) return;
		state.views.delete(view);
		try {
			let win = view._iframeWindow;
			let doc = win.document;
			let app = win.PDFViewerApplication;

			if (entry.pending) {
				clearTimeout(entry.pending);
				entry.pending = null;
			}
			for (let [name, handler] of entry.busEvents) app.eventBus.off(name, handler);
			for (let [target, name, handler] of entry.domEvents) {
				target.removeEventListener(name, handler);
			}

			let viewerEl = doc.getElementById('viewer');
			if (viewerEl) {
				viewerEl.classList.remove(this.VIEWER_CLASS);
				for (let page of viewerEl.querySelectorAll('.page')) {
					for (let name of ['--ctm-t', '--ctm-r', '--ctm-b', '--ctm-l']) {
						page.style.removeProperty(name);
					}
				}
			}
			doc.body.classList.remove(this.FIT_CLASS);
			if (entry.style && entry.style.parentNode) {
				entry.style.parentNode.removeChild(entry.style);
			}

			app.pdfViewer.currentScaleValue = entry.previousScaleValue || 'page-width';
		}
		catch (e) {
			this.logError(e);
		}
	},

	reapply(state, view) {
		this.stampAll(state, view);
		this.fit(state, view);
	},

	onPageRendered(state, view, index) {
		this.stampPage(state, view, index);
		this.guardPage(state, view, index).catch(e => this.logError(e));
	},

	/**
	 * The crop to use for one page: the document's, unless this page has been
	 * found to carry text outside it.
	 */
	boxFor(entry, pageNumber) {
		let override = entry.pageBoxes.get(pageNumber - 1);
		if (override) return override;
		return (pageNumber % 2 === 1) ? entry.crop.odd : entry.crop.even;
	},

	/**
	 * Front and back matter — indexes, tables, plates — sometimes set type wider
	 * than the body of the book does. One crop for the whole document would slice
	 * those pages, so any page whose *text* reaches past the crop keeps as much of
	 * its own margin as it needs. The check only ever crops less, never more, so
	 * it cannot cost a page any ink, and it leaves the majority of the document on
	 * the single shared crop.
	 */
	async guardPage(state, view, index) {
		if (!this.getPref('guardPages')) return;
		let entry = state.views.get(view);
		if (!entry || !entry.crop || entry.checked.has(index)) return;
		entry.checked.add(index);

		let win = view._iframeWindow;
		let app = win.PDFViewerApplication;
		let page = await app.pdfDocument.getPage(index + 1);
		let content = await page.getTextContent();
		let items = content.items;
		if (!items || !items.length) return;

		let box = page.view;
		let pageWidth = box[2] - box[0];
		let pageHeight = box[3] - box[1];
		if (!(pageWidth > 0) || !(pageHeight > 0)) return;

		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
		for (let i = 0; i < items.length; i++) {
			let item = items[i];
			if (!item || !item.str || !item.str.trim()) continue;
			let transform = item.transform;
			if (!transform || transform.length < 6) continue;
			let x = transform[4];
			let y = transform[5];
			let w = item.width || 0;
			let h = item.height || 0;
			if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
			if (x < minX) minX = x;
			if (x + w > maxX) maxX = x + w;
			// The transform sits on the baseline, so allow for descenders.
			if (y - h * 0.25 < minY) minY = y - h * 0.25;
			if (y + h > maxY) maxY = y + h;
		}
		if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

		let actual = {
			l: this.clamp((minX - box[0]) / pageWidth, 0, 1),
			r: this.clamp((box[2] - maxX) / pageWidth, 0, 1),
			t: this.clamp((box[3] - maxY) / pageHeight, 0, 1),
			b: this.clamp((minY - box[1]) / pageHeight, 0, 1)
		};
		let padX = this.clamp(this.getPref('padding'), 0, 144) / pageWidth;
		let padY = this.clamp(this.getPref('padding'), 0, 144) / pageHeight;
		let shared = (index + 1) % 2 === 1 ? entry.crop.odd : entry.crop.even;

		const TOLERANCE = 0.005;
		let relaxed = null;
		for (let [side, pad] of [['l', padX], ['r', padX], ['t', padY], ['b', padY]]) {
			if (actual[side] < shared[side] - TOLERANCE) {
				relaxed = relaxed || Object.assign({}, shared);
				relaxed[side] = Math.max(0, Math.min(shared[side], actual[side] - pad));
			}
		}
		if (!relaxed) return;

		this.trace('page ' + (index + 1) + ' sets type outside the document crop; relaxing it');
		entry.pageBoxes.set(index, relaxed);
		this.stampPage(state, view, index);
	},

	/** Crop of one page, in PDF points, rotated into the orientation on screen. */
	displayCrop(pageView, side) {
		let viewport = pageView.viewport;
		let dims = viewport.rawDims;
		let pw = dims.pageWidth;
		let ph = dims.pageHeight;
		let rotation = ((viewport.rotation % 360) + 360) % 360;

		let t, r, b, l;
		switch (rotation) {
			case 90:
				t = side.l * pw; r = side.t * ph; b = side.r * pw; l = side.b * ph;
				break;
			case 180:
				t = side.b * ph; r = side.l * pw; b = side.t * ph; l = side.r * pw;
				break;
			case 270:
				t = side.r * pw; r = side.b * ph; b = side.l * pw; l = side.t * ph;
				break;
			default:
				t = side.t * ph; r = side.r * pw; b = side.b * ph; l = side.l * pw;
		}
		let swapped = rotation % 180 !== 0;
		return { t, r, b, l, width: swapped ? ph : pw, height: swapped ? pw : ph };
	},

	stampPage(state, view, index) {
		let entry = state.views.get(view);
		if (!entry || !entry.crop) return;
		try {
			let viewer = view._iframeWindow.PDFViewerApplication.pdfViewer;
			let pageView = viewer.getPageView(index);
			if (!pageView || !pageView.div || !pageView.viewport) return;
			let box = this.displayCrop(pageView, this.boxFor(entry, pageView.id));
			let style = pageView.div.style;
			style.setProperty('--ctm-t', String(box.t));
			style.setProperty('--ctm-r', String(box.r));
			style.setProperty('--ctm-b', String(box.b));
			style.setProperty('--ctm-l', String(box.l));
		}
		catch (e) {
			this.logError(e);
		}
	},

	stampAll(state, view) {
		let entry = state.views.get(view);
		if (!entry || !entry.crop) return;
		try {
			let count = view._iframeWindow.PDFViewerApplication.pdfViewer.pagesCount;
			for (let i = 0; i < count; i++) this.stampPage(state, view, i);
		}
		catch (e) {
			this.logError(e);
		}
	},

	/** Zoom so the cropped text block fills the pane. */
	fit(state, view) {
		let entry = state.views.get(view);
		if (!entry) return;
		try {
			let win = view._iframeWindow;
			let viewer = win.PDFViewerApplication.pdfViewer;
			let container = win.document.getElementById('viewerContainer');
			let pageView = viewer.getPageView(Math.max(0, viewer.currentPageNumber - 1))
				|| viewer.getPageView(0);
			if (!container || !pageView || !pageView.viewport) return;

			// The shared crop, not this page's override: a relaxed outlier should not
			// re-zoom the whole document.
			let shared = (pageView.id % 2 === 1) ? entry.crop.odd : entry.crop.even;
			let box = this.displayCrop(pageView, shared);
			let widthFraction = 1 - (box.l + box.r) / box.width;
			let heightFraction = 1 - (box.t + box.b) / box.height;
			if (!(widthFraction > 0) || !(heightFraction > 0)) return;

			// pdf.js's own "page width" arithmetic, divided by what survives the crop.
			let horizontalPadding = this.SCROLLBAR_PADDING;
			let verticalPadding = this.VERTICAL_PADDING;
			if (viewer.scrollMode === this.SCROLL_MODE_HORIZONTAL) {
				[horizontalPadding, verticalPadding] = [verticalPadding, horizontalPadding];
			}
			let spreadFactor = (viewer.spreadMode !== this.SPREAD_MODE_NONE
				&& viewer.scrollMode !== this.SCROLL_MODE_HORIZONTAL) ? 2 : 1;

			let widthScale = ((container.clientWidth - horizontalPadding) / pageView.width)
				* pageView.scale / spreadFactor / widthFraction;
			let scale = widthScale;
			if (this.getPref('fitMode') === 'page') {
				let heightScale = ((container.clientHeight - verticalPadding) / pageView.height)
					* pageView.scale / heightFraction;
				scale = Math.min(widthScale, heightScale);
			}
			scale = this.clamp(scale, this.MIN_SCALE, this.MAX_SCALE);

			entry.appliedScale = Math.round(scale * 10000) / 10000;
			viewer.currentScaleValue = String(entry.appliedScale);
			this.updateFitClass(state, view);
		}
		catch (e) {
			this.logError(e);
		}
	},

	/** Re-fit on resize, but only while the user has not taken over the zoom. */
	refit(state, view) {
		let entry = state.views.get(view);
		if (!entry || entry.appliedScale === null) return;
		try {
			let viewer = view._iframeWindow.PDFViewerApplication.pdfViewer;
			if (Math.abs(viewer.currentScale - entry.appliedScale) > 0.001) {
				this.updateFitClass(state, view);
				return;
			}
			this.fit(state, view);
		}
		catch (e) {
			this.logError(e);
		}
	},

	/**
	 * Settle work after scrolling or zooming: check whether the scrollbar is still
	 * unnecessary, and guard whatever page the reader has landed on. Scroll is a
	 * DOM event, so this keeps working even where the page-rendered hook could not
	 * be installed.
	 */
	scheduleFitClass(state, view) {
		let entry = state.views.get(view);
		if (!entry || entry.pending) return;
		entry.pending = setTimeout(() => {
			entry.pending = null;
			this.updateFitClass(state, view);
			try {
				let viewer = view._iframeWindow.PDFViewerApplication.pdfViewer;
				this.guardPage(state, view, Math.max(0, viewer.currentPageNumber - 1))
					.catch(e => this.logError(e));
			}
			catch (e) {
				this.logError(e);
			}
		}, 200);
	},

	/**
	 * Suppress the horizontal scrollbar while the cropped page fits the pane —
	 * the paper we clipped away still counts towards the scroll width — but hand
	 * it back the moment the reader zooms in past the fit.
	 */
	updateFitClass(state, view) {
		let entry = state.views.get(view);
		if (!entry || !entry.crop) return;
		try {
			let win = view._iframeWindow;
			let doc = win.document;
			let viewer = win.PDFViewerApplication.pdfViewer;
			let container = doc.getElementById('viewerContainer');
			let pageView = viewer.getPageView(Math.max(0, viewer.currentPageNumber - 1))
				|| viewer.getPageView(0);
			if (!container || !pageView || !pageView.viewport) return;
			let box = this.displayCrop(pageView, this.boxFor(entry, pageView.id));
			let visible = pageView.width * (1 - (box.l + box.r) / box.width);
			let fits = visible <= container.clientWidth - this.VIEWER_PADDING + 1;
			doc.body.classList.toggle(this.FIT_CLASS, fits);
		}
		catch (e) {
			this.logError(e);
		}
	}
};
