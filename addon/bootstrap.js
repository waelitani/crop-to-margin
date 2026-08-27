/* Zotero plugin entry points. Loaded into a system-principal sandbox, so the
   subscript below shares this global and defines CropToMargin in it. */

var CropToMargin;
var pluginScope = this;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	// ignoreCache matters more than it looks. The subscript loader caches compiled
	// scripts by URL for the life of the process, and the URL here is the plugin's
	// ID, which does not change between versions — so without this, upgrading the
	// plugin in a running Zotero silently re-runs whichever version was loaded
	// first. Zotero loads this very file the same way, for the same reason.
	Services.scriptloader.loadSubScriptWithOptions(rootURI + 'content/crop-to-margin.js', {
		target: pluginScope,
		ignoreCache: true
	});
	await CropToMargin.init({ id, version, rootURI });
}

function shutdown() {
	if (CropToMargin) {
		CropToMargin.shutdown();
		CropToMargin = undefined;
	}
}
