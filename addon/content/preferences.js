/* Preferences pane for Crop to Margin.
 *
 * Pane scripts run in a sandbox whose prototype is the preferences window, and
 * inline oncommand attributes are compiled against the window itself, so the
 * handler object is published onto the window rather than kept local.
 */

window.CropToMarginPrefs = {
	PREF: 'extensions.zotero.crop-to-margin.',

	init(pane) {
		this.pane = pane;
		this.bindKeepPercent();
		this.updateCacheCount();
	},

	/*
	 * The pref is the percentile a side is cropped to; the field asks the more
	 * useful question, "how many pages must survive untouched?" — the complement.
	 */
	bindKeepPercent() {
		let input = this.pane.querySelector('#ctm-keep');
		if (!input) return;
		let read = () => {
			let quantile = Zotero.Prefs.get(this.PREF + 'quantile', true);
			if (typeof quantile !== 'number') quantile = 15;
			input.value = String(100 - quantile);
		};
		input.addEventListener('change', () => {
			let keep = parseInt(input.value, 10);
			if (!Number.isFinite(keep)) return read();
			keep = Math.min(100, Math.max(50, keep));
			input.value = String(keep);
			Zotero.Prefs.set(this.PREF + 'quantile', 100 - keep, true);
		});
		read();
	},

	countCached() {
		try {
			let cache = JSON.parse(Zotero.Prefs.get(this.PREF + 'cache', true) || '{}');
			return Object.keys(cache).length;
		}
		catch (e) {
			return 0;
		}
	},

	updateCacheCount() {
		let label = this.pane && this.pane.querySelector('#ctm-cache-count');
		if (!label) return;
		let count = this.countCached();
		label.value = count === 1 ? '1 remembered' : count + ' remembered';
	},

	clearCache() {
		Zotero.Prefs.set(this.PREF + 'cache', '{}', true);
		this.updateCacheCount();
	}
};

// The pane fires 'load' on its root once it is in the document. The event does
// not bubble, so listen during the capture phase.
document.addEventListener('load', (event) => {
	if (event.target && event.target.id === 'crop-to-margin-prefs') {
		try {
			window.CropToMarginPrefs.init(event.target);
		}
		catch (e) {
			Zotero.logError(e);
		}
	}
}, true);
