/* Zotero plugin entry points. Loaded into a system-principal sandbox, so the
   subscript below shares this global and defines CropToMargin in it. */

var CropToMargin;
var pluginScope = this;

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + 'content/crop-to-margin.js', pluginScope);
	await CropToMargin.init({ id, version, rootURI });
}

function shutdown() {
	if (CropToMargin) {
		CropToMargin.shutdown();
		CropToMargin = undefined;
	}
}
