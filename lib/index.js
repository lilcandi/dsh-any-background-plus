import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
//#region src/host-compat/channel.ts
/** What this plugin supports, in upgrade order. One row = one build whose facts
*  were checked; several rows may share a `channel` when a newer build was
*  verified as needing no change to that folder's adapter (as `0.1.7-rc.1` was) —
*  a row then reports `exact` instead of `line`, and no new folder appears.
*  Adding an ADAPTER means adding a channel plus a folder in
*  `client/host-compat/versions/`. */
const SUPPORTED_RELEASES = [
	{
		channel: "0.1.5-rc",
		release: "0.1.5-rc.2"
	},
	{
		channel: "0.1.6-alpha",
		release: "0.1.6-alpha.2"
	},
	{
		channel: "0.1.7-alpha",
		release: "0.1.7-alpha.2"
	},
	{
		channel: "0.1.7-alpha",
		release: "0.1.7-rc.1"
	},
	{
		channel: "0.1.7-alpha",
		release: "0.1.7-rc.2"
	}
];
const UNKNOWN_HOST_INFO = {
	version: null,
	channel: "unknown"
};
/** True when a string looks like a release version. A bare `~/.dsh` directory
*  basename does not, which is why the disk probe sanity-checks before trusting
*  a path segment. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
function looksLikeVersion(value) {
	return VERSION_RE.test(value);
}
const PARSE_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
function parse(version) {
	const m = PARSE_RE.exec(version);
	if (m === null) return null;
	const parts = m[4] === void 0 ? [] : m[4].split(".");
	const build = parts.length > 1 ? Number(parts[1]) : NaN;
	return {
		core: [
			Number(m[1]),
			Number(m[2]),
			Number(m[3])
		],
		channel: parts.length > 0 ? parts[0] : null,
		build: Number.isFinite(build) ? build : null
	};
}
/** The table, parsed once: every row is a literal this file controls. */
const TABLE = SUPPORTED_RELEASES.map((row) => ({
	...row,
	parsed: parse(row.release)
}));
function cmpCore(a, b) {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	return 0;
}
/** Total order over releases, following the semver rule that a prerelease sorts
*  BELOW the release it precedes (`0.1.6-alpha.2 < 0.1.6`). */
function cmp(a, b) {
	const core = cmpCore(a.core, b.core);
	if (core !== 0) return core;
	if (a.channel === null || b.channel === null) {
		if (a.channel === b.channel) return 0;
		return a.channel === null ? 1 : -1;
	}
	if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1;
	const ab = a.build ?? 0;
	const bb = b.build ?? 0;
	return ab === bb ? 0 : ab < bb ? -1 : 1;
}
/** Pick the adapter for a release, clamping to the nearest verified line when the
*  release is outside everything this plugin has seen.
*
*  A release is matched by PATCH LINE before anything else: `0.1.6-alpha.4` and a
*  future `0.1.6` stable both belong to the line verified at `0.1.6-alpha.2`, and
*  handing them that adapter beats giving up — the DOM probes only cover panel
*  mechanics, not the surface decisions the line is known for.
*
*  Outside every verified line the answer is a guess, so it is the closest one and
*  it says so (`nearest`): newer than the newest line → that newest adapter, older
*  than the oldest → the oldest, strictly between two → the LOWER one, because an
*  adapter may only claim what it was verified for. A release that will not parse
*  at all is `unknown`, and the DOM arbitrates there. */
function classifyRelease(version) {
	const host = version === null ? null : parse(version);
	if (host === null) return {
		channel: "unknown",
		match: "unresolved"
	};
	const sameLine = TABLE.filter((row) => cmpCore(row.parsed.core, host.core) === 0);
	if (sameLine.length > 0) {
		const exact = sameLine.find((row) => row.release === version);
		if (exact !== void 0) return {
			channel: exact.channel,
			match: "exact"
		};
		const atOrBelow = sameLine.filter((row) => cmp(row.parsed, host) <= 0);
		return {
			channel: (atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : sameLine[0]).channel,
			match: "line"
		};
	}
	const older = TABLE.filter((row) => cmp(row.parsed, host) < 0);
	if (older.length === 0) return {
		channel: TABLE[0].channel,
		match: "nearest"
	};
	if (TABLE.filter((row) => cmp(row.parsed, host) > 0).length === 0) return {
		channel: TABLE[TABLE.length - 1].channel,
		match: "nearest"
	};
	return {
		channel: older[older.length - 1].channel,
		match: "nearest"
	};
}
//#endregion
//#region src/host-compat/detect.ts
/**
* The front door: resolve which DSH release this plugin is running under.
*
* WHY IT RUNS HERE (node) AND NOT IN THE BROWSER
* The client context exposes no host version — verified against the harness: no
* `hostVersion`/`dshVersion` field on `ctx`, and `window.__DSH_BOOT__.version` is
* the module-table format tag `'client'`, not a release. Capability probing alone
* is also not enough, because the obvious probes do not separate the release
* lines:
* `ctx.sidebarRightTabs` and the `[data-sidebar-right-panel]` marker both exist on
* 0.1.5-rc.2 already, so either one used as a "0.1.6+" test mis-classifies 0.1.5
* as newer. The install the process was composed FROM states the release directly,
* and only the node half can read it.
*
* Three hops, most authoritative first:
*   1. `ctx.profileContext.installAnchor` — the absolute path of the running
*      app's own manifest (`<…>/node_modules/@deepseek-ai/dsh/package.json`; the
*      host passes exactly that file, `new URL('../package.json', import.meta.url)`
*      of its `dsh` package). Whatever process is serving this plugin is what that
*      manifest versioned, so it needs no path guessing. Provided by
*      `dsh-app-boot` only in a dsh-launched profile, hence optional.
*   2. The installed manifest next to the launcher home:
*      `<root>/versions/<ver>/node_modules/@deepseek-ai/dsh/package.json`, reached
*      from `$DSH_HOME`'s `homes/<ver>` layout. For a host that gives no
*      `profileContext`.
*   3. `$DSH_HOME`'s basename, because launcher homes live in a folder named after
*      the release (`.../homes/0.1.6-alpha.2`). A user may point DSH_HOME at a
*      plain `~/.dsh` (no launcher layout at all), whose basename is not a
*      version — hence `looksLikeVersion` gates it.
*
* A release that resolves but matches no verified patch line is clamped to the
* nearest adapter by `classifyRelease()`; only a release that will not parse at
* all degrades to `version: null` / `channel: 'unknown'`, where the client half
* falls back to DOM-shape probing. That fallback is not hypothetical: a plain
* `~/.dsh` install lands here, and a wrong guess would silently restyle the
* user's window.
*
* @module
*/
/** What "the verified lines" are, spelled out for the clamp log below. */
const SUPPORTED_HINT = SUPPORTED_RELEASES.map((row) => row.release).join(" ~ ");
/** Read the `version` field of a package manifest, or null when the file is
*  missing, unreadable, not JSON or does not declare a release-looking version —
*  every one of which just means "this hop has no answer". */
async function manifestVersion(file) {
	try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		if (typeof raw.version === "string" && looksLikeVersion(raw.version.trim())) return raw.version.trim();
	} catch {}
	return null;
}
/** Hop 1: the anchor the host itself hands us. A custom composition may point it
*  at its own manifest, whose `version` is whatever that project calls itself —
*  `looksLikeVersion` inside `manifestVersion` is what keeps a non-release out. */
async function versionFromAnchor(anchor) {
	if (typeof anchor !== "string" || anchor === "") return null;
	if (!/[/\\]package\.json$/.test(anchor)) return null;
	return manifestVersion(anchor);
}
/** Hop 2: the installed manifest two levels up from a launcher home
*  (`<root>/homes/<ver>` → `<root>/versions/<ver>`), or null when the layout does
*  not apply (plain `~/.dsh`, non-launcher hosts). */
async function versionFromLauncher(homeDir) {
	const root = dirname(dirname(homeDir));
	const versionSeg = basename(homeDir);
	if (!looksLikeVersion(versionSeg)) return null;
	return manifestVersion(join(root, "versions", versionSeg, "node_modules", "@deepseek-ai", "dsh", "package.json"));
}
/** Cached verdict: the probe touches the filesystem, and the host release never
*  changes within a process lifetime. */
let cache;
/** Resolve (and cache) the host release + channel. `installAnchor` is
*  `ctx.profileContext?.installAnchor`, read at plugin mount time.
*
*  A clamped verdict (`nearest`) is logged once: it means the plugin is styling a
*  release it was never verified against, and that is the first thing to know when
*  a new host build reports a broken surface. */
async function resolveHostInfo(installAnchor) {
	if (cache !== void 0) return cache;
	const homeDir = dshHomePath();
	let version = await versionFromAnchor(installAnchor);
	if (version === null) version = await versionFromLauncher(homeDir);
	if (version === null) {
		const seg = basename(homeDir);
		if (looksLikeVersion(seg)) version = seg;
	}
	const verdict = classifyRelease(version);
	if (verdict.match === "nearest") console.log(`dsh-any-background: host release ${version} is outside the verified lines, styling it as ${verdict.channel} (supports ${SUPPORTED_HINT})`);
	cache = {
		version,
		channel: verdict.channel
	};
	return cache;
}
//#endregion
//#region src/index.ts
/**
* Node half of dsh-any-background: file-backed theme persistence.
*
* Owns the `~/.dsh/.dsh-any-background-data/` store and exposes a small RPC
* surface on the dedicated `/dsh-any-background` channel (never the shared
* `/api`, so slash commands stay intact).
*
*   theme-config.json   settings
*   wallpaper.jpg       background image
*/
const name = "dsh-any-background";
const inject = ["connection", "webServer"];
const DATA_DIR = ".dsh-any-background-data";
const CONFIG_FILE = "theme-config.json";
const WALLPAPER_FILE = "wallpaper.jpg";
const ROTATION_DIR = "rotation";
const MAX_FOLDER_IMAGES = 2e4;
const WALLPAPER_ROUTE = "/dsh-any-background/wallpaper";
const WALLPAPER_RIGHT_FILE = "wallpaper-right.jpg";
const WALLPAPER_RIGHT_ROUTE = "/dsh-any-background/wallpaper-right";
const WALLPAPER_UPLOAD_ROUTE = "/dsh-any-background/wallpaper/upload";
const FONT_ROUTE = "/dsh-any-background/font";
const FONT_UPLOAD_ROUTE = "/dsh-any-background/font/upload";
const UPLOAD_TMP = "wallpaper.upload.tmp";
const FONT_UPLOAD_TMP = "font.upload.tmp";
const WALLPAPER_UPLOAD_MAX = 104857600;
const FONT_UPLOAD_MAX = 104857600;
const WALLPAPER_FETCH_MAX = 26214400;
const WALLPAPER_FETCH_TIMEOUT = 2e4;
/** Font slot: one font owns the slot, named by format. */
function fontFileName(mime) {
	switch (mime) {
		case "font/woff2": return "font.woff2";
		case "font/woff": return "font.woff";
		case "font/otf": return "font.otf";
		case "font/ttf": return "font.ttf";
		default: return "font.ttf";
	}
}
const FONT_CANDIDATES = [
	"font.woff2",
	"font.woff",
	"font.otf",
	"font.ttf"
];
/** Sniff a font's container format from its leading magic bytes (null when the
*  bytes are not a recognized font — uploads are rejected rather than stored). */
function sniffFontMime(buf) {
	if (buf.length >= 4 && buf[0] === 119 && buf[1] === 79 && buf[2] === 70 && buf[3] === 50) return "font/woff2";
	if (buf.length >= 4 && buf[0] === 119 && buf[1] === 79 && buf[2] === 70 && buf[3] === 70) return "font/woff";
	if (buf.length >= 4 && buf[0] === 79 && buf[1] === 84 && buf[2] === 84 && buf[3] === 79) return "font/otf";
	if (buf.length >= 4 && buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0) return "font/ttf";
	return null;
}
/** Bounds of the `minutes` cadence, applied by both halves so an edited config
*  cannot ask for a sub-minute timer (a whole wallpaper is copied per advance)
*  or for a gap longer than a day (that is what `daily` is for). */
const INTERVAL_MINUTES_MIN = 1;
const INTERVAL_MINUTES_MAX = 1440;
const DEFAULT_CONFIG = {
	color: null,
	opacities: {
		bg: 0,
		sidebar: .5,
		card: .5,
		input: .5
	},
	blurs: {
		bg: 0,
		sidebar: 30,
		card: 30,
		settings: 30,
		chat: 30,
		trajectory: 30,
		input: 30,
		panel: 30,
		produced: 30,
		header: 30
	},
	strokes: {
		bg: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		sidebar: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		card: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		settings: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		chat: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		trajectory: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		input: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		panel: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		produced: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		},
		header: {
			width: 0,
			color: "auto",
			customColor: "#808080"
		}
	},
	settingsOpacity: .5,
	wallpaperOpacity: 1,
	wpEdgeFade: 0,
	blur: 0,
	bgState: {
		zoom: 1,
		x: 0,
		y: 0,
		iw: 0,
		ih: 0
	},
	backgroundType: "image",
	bgMode: "fit",
	fontMime: null,
	fontEnabled: true,
	generatedBg: null,
	regenerateOnReload: false,
	chatTextOpacity: .5,
	trajectoryOpacity: .5,
	panelOpacity: .5,
	producedOpacity: .5,
	headerOpacity: .5,
	profiles: [],
	rotation: {
		enabled: false,
		source: "pool",
		folder: null,
		folderCount: 0,
		folderRight: null,
		folderRightCount: 0,
		mode: "shuffle",
		interval: "daily",
		intervalMinutes: 5,
		dual: false,
		laneItems: [],
		current: 0,
		items: [],
		lastRotate: null
	},
	schedule: {
		enabled: false,
		mode: "time",
		dayProfile: null,
		nightProfile: null,
		dayStart: "07:00",
		nightStart: "19:00"
	},
	schemeOverride: "auto",
	activeProfile: null
};
const dataDir = () => dshHomePath(DATA_DIR);
const configPath = () => dshHomePath(DATA_DIR, CONFIG_FILE);
const wallpaperPath = () => dshHomePath(DATA_DIR, WALLPAPER_FILE);
const wallpaperRightPath = () => dshHomePath(DATA_DIR, WALLPAPER_RIGHT_FILE);
const fontPathFor = (mime) => dshHomePath(DATA_DIR, fontFileName(mime));
const exists = async (p) => {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
};
function clamp(n, lo, hi, def) {
	return typeof n === "number" && isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
}
/** Locate the stored font: the recorded MIME decides the expected name; stray
*  files from a lost config write are adopted via rename. */
async function findFontFile() {
	const mime = (await readConfig()).fontMime ?? "font/ttf";
	const expected = fontPathFor(mime);
	if (await exists(expected)) return {
		path: expected,
		mime
	};
	for (const name of FONT_CANDIDATES) {
		const p = dshHomePath(DATA_DIR, name);
		if (!await exists(p)) continue;
		const foundMime = mimeForFontFile(name);
		try {
			await rename(p, expected);
			return {
				path: expected,
				mime: foundMime
			};
		} catch {
			return null;
		}
	}
	return null;
}
function mimeForFontFile(name) {
	switch (name) {
		case "font.woff2": return "font/woff2";
		case "font.woff": return "font/woff";
		case "font.otf": return "font/otf";
		default: return "font/ttf";
	}
}
async function fontUrl() {
	return await findFontFile() ? FONT_ROUTE : null;
}
function normalizeBgState(s) {
	return {
		zoom: clamp(s.zoom, .1, 10, 1),
		x: typeof s.x === "number" && isFinite(s.x) ? s.x : 0,
		y: typeof s.y === "number" && isFinite(s.y) ? s.y : 0,
		iw: typeof s.iw === "number" && s.iw > 0 ? s.iw : 0,
		ih: typeof s.ih === "number" && s.ih > 0 ? s.ih : 0
	};
}
/** Coerce an unknown persisted value into a valid ThemeConfig, falling back per-field. */
const STROKE_GROUPS = [
	"bg",
	"sidebar",
	"card",
	"settings",
	"chat",
	"trajectory",
	"input",
	"panel",
	"produced",
	"header"
];
const STROKE_COLOR_KEYS = [
	"auto",
	"gray",
	"black",
	"white",
	"theme",
	"custom"
];
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function normalizeStroke(raw) {
	const s = raw ?? {};
	return {
		width: clamp(s.width, 0, 4, 0),
		color: STROKE_COLOR_KEYS.includes(s.color) ? s.color : "auto",
		customColor: typeof s.customColor === "string" && HEX_RE.test(s.customColor) ? s.customColor : "#808080"
	};
}
function normalizeStrokes(raw) {
	const s = raw ?? {};
	const out = {};
	for (const k of STROKE_GROUPS) out[k] = normalizeStroke(s[k]);
	return out;
}
function normalizeConfig(raw) {
	const r = raw ?? {};
	const c = r.color;
	const color = Array.isArray(c) && c.length === 3 && c.every((x) => typeof x === "number" && isFinite(x)) ? [
		clamp(c[0], 0, 360, 220),
		clamp(c[1], 0, 1, .55),
		clamp(c[2], 0, 1, .25)
	] : null;
	const bgType = [
		"image",
		"mesh",
		"shader",
		"pattern"
	].includes(r.backgroundType) ? r.backgroundType : DEFAULT_CONFIG.backgroundType;
	const bgMode = [
		"fit",
		"fill",
		"stretch",
		"tile",
		"center"
	].includes(r.bgMode) ? r.bgMode : DEFAULT_CONFIG.bgMode;
	const gen = r.generatedBg && typeof r.generatedBg === "object" ? r.generatedBg : null;
	const generatedBg = gen && gen.type === bgType ? normalizeGeneratedBg(r.generatedBg) : null;
	const legacy = typeof r.opacity === "number" ? r.opacity : null;
	const ops = r.opacities ?? {};
	const bl = r.blurs ?? {};
	const blurs = {};
	for (const k of [
		"bg",
		"sidebar",
		"card",
		"settings",
		"chat",
		"trajectory",
		"input",
		"panel",
		"produced",
		"header"
	]) blurs[k] = clamp(bl[k], 0, 60, DEFAULT_CONFIG.blurs[k]);
	return {
		color,
		opacities: {
			bg: clamp(ops.bg, 0, 1, legacy ?? DEFAULT_CONFIG.opacities.bg),
			sidebar: clamp(ops.sidebar, 0, 1, legacy !== null ? Math.min(1, legacy + .08) : DEFAULT_CONFIG.opacities.sidebar),
			card: clamp(ops.card, 0, 1, DEFAULT_CONFIG.opacities.card),
			input: clamp(ops.input, 0, 1, DEFAULT_CONFIG.opacities.input)
		},
		blurs,
		strokes: normalizeStrokes(r.strokes),
		settingsOpacity: clamp(r.settingsOpacity, 0, 1, DEFAULT_CONFIG.settingsOpacity),
		wallpaperOpacity: clamp(r.wallpaperOpacity, 0, 1, DEFAULT_CONFIG.wallpaperOpacity),
		wpEdgeFade: clamp(r.wpEdgeFade, 0, 100, DEFAULT_CONFIG.wpEdgeFade),
		blur: clamp(r.blur, 0, 60, DEFAULT_CONFIG.blur),
		bgState: normalizeBgState(r.bgState ?? {}),
		backgroundType: bgType,
		bgMode,
		fontMime: typeof r.fontMime === "string" ? r.fontMime : null,
		fontEnabled: typeof r.fontEnabled === "boolean" ? r.fontEnabled : DEFAULT_CONFIG.fontEnabled,
		generatedBg,
		regenerateOnReload: typeof r.regenerateOnReload === "boolean" ? r.regenerateOnReload : DEFAULT_CONFIG.regenerateOnReload,
		chatTextOpacity: clamp(r.chatTextOpacity, 0, 1, DEFAULT_CONFIG.chatTextOpacity),
		trajectoryOpacity: clamp(r.trajectoryOpacity, 0, 1, DEFAULT_CONFIG.trajectoryOpacity),
		panelOpacity: clamp(r.panelOpacity, 0, 1, DEFAULT_CONFIG.panelOpacity),
		producedOpacity: clamp(r.producedOpacity, 0, 1, DEFAULT_CONFIG.producedOpacity),
		headerOpacity: clamp(r.headerOpacity, 0, 1, DEFAULT_CONFIG.headerOpacity),
		profiles: normalizeProfiles(r.profiles),
		rotation: normalizeRotation(r.rotation),
		schedule: normalizeSchedule(r.schedule),
		schemeOverride: r.schemeOverride === "light" || r.schemeOverride === "dark" ? r.schemeOverride : "auto",
		activeProfile: typeof r.activeProfile === "string" ? r.activeProfile : null
	};
}
function normalizeGeneratedBg(p) {
	if (p.type === "mesh") return {
		type: "mesh",
		seed: typeof p.seed === "number" ? p.seed : 0,
		scale: clamp(p.scale, .3, 3, 1),
		intensity: clamp(p.intensity, 0, 1, .6)
	};
	if (p.type === "shader") return {
		type: "shader",
		preset: [
			"aurora",
			"nebula",
			"noise",
			"starfield"
		].includes(p.preset) ? p.preset : "aurora",
		speed: clamp(p.speed, 0, 2, .3),
		scale: clamp(p.scale, .3, 3, 1),
		seed: typeof p.seed === "number" ? Math.floor(p.seed) : 0
	};
	if (p.type === "pattern") return {
		type: "pattern",
		preset: [
			"dots",
			"waves",
			"poly",
			"rain",
			"contour",
			"meta"
		].includes(p.preset) ? p.preset : "dots",
		density: clamp(p.density, 0, 1, .5),
		scale: clamp(p.scale, .3, 3, 1),
		seed: typeof p.seed === "number" ? Math.floor(p.seed) : 0
	};
	return null;
}
const MAX_PROFILES = 20;
const MAX_ROTATION_ITEMS = 30;
const MAX_THUMB_BYTES = 65536;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Coerce an unknown value into a ProfileAppearance (appearance subset only). */
function normalizeProfileAppearance(raw) {
	const a = raw ?? {};
	const c = a.color;
	const ops = a.opacities ?? {};
	const bl = a.blurs ?? {};
	const blurs = {};
	for (const k of [
		"bg",
		"sidebar",
		"card",
		"settings",
		"chat",
		"trajectory",
		"input",
		"panel",
		"produced"
	]) blurs[k] = clamp(bl[k], 0, 60, DEFAULT_CONFIG.blurs[k]);
	return {
		color: Array.isArray(c) && c.length === 3 && c.every((x) => typeof x === "number" && isFinite(x)) ? [
			clamp(c[0], 0, 360, 220),
			clamp(c[1], 0, 1, .55),
			clamp(c[2], 0, 1, .25)
		] : null,
		opacities: {
			bg: clamp(ops.bg, 0, 1, DEFAULT_CONFIG.opacities.bg),
			sidebar: clamp(ops.sidebar, 0, 1, DEFAULT_CONFIG.opacities.sidebar),
			card: clamp(ops.card, 0, 1, DEFAULT_CONFIG.opacities.card),
			input: clamp(ops.input, 0, 1, DEFAULT_CONFIG.opacities.input)
		},
		blurs,
		strokes: normalizeStrokes(a.strokes),
		settingsOpacity: clamp(a.settingsOpacity, 0, 1, DEFAULT_CONFIG.settingsOpacity),
		wallpaperOpacity: clamp(a.wallpaperOpacity, 0, 1, DEFAULT_CONFIG.wallpaperOpacity),
		wpEdgeFade: clamp(a.wpEdgeFade, 0, 100, DEFAULT_CONFIG.wpEdgeFade),
		blur: clamp(a.blur, 0, 60, DEFAULT_CONFIG.blur),
		chatTextOpacity: clamp(a.chatTextOpacity, 0, 1, DEFAULT_CONFIG.chatTextOpacity),
		trajectoryOpacity: clamp(a.trajectoryOpacity, 0, 1, DEFAULT_CONFIG.trajectoryOpacity),
		panelOpacity: clamp(a.panelOpacity, 0, 1, DEFAULT_CONFIG.panelOpacity),
		producedOpacity: clamp(a.producedOpacity, 0, 1, DEFAULT_CONFIG.producedOpacity),
		headerOpacity: clamp(a.headerOpacity, 0, 1, DEFAULT_CONFIG.headerOpacity)
	};
}
function normalizeProfiles(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	for (const item of raw.slice(0, MAX_PROFILES)) {
		const p = item ?? {};
		if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 64) continue;
		if (out.some((e) => e.id === p.id)) continue;
		out.push({
			id: p.id,
			name: typeof p.name === "string" && p.name.trim() ? p.name.slice(0, 60) : "Profile",
			createdAt: typeof p.createdAt === "string" ? p.createdAt : "",
			config: normalizeProfileAppearance(p.config)
		});
	}
	return out;
}
/** Rotation items live as files under the rotation dir; only the server
*  creates those names, so a stored `file` is accepted only when it is a bare
*  filename with a known image extension (no path traversal). */
function safeRotationFile(name) {
	if (typeof name !== "string" || !/^[\w-]+\.(jpg|jpeg|png|gif|webp)$/i.test(name)) return null;
	return name;
}
function normalizeRotation(raw) {
	const r = raw ?? {};
	const items = [];
	if (Array.isArray(r.items)) for (const item of r.items.slice(0, MAX_ROTATION_ITEMS)) {
		const it = item ?? {};
		const file = safeRotationFile(it.file);
		if (file === null) continue;
		items.push({
			file,
			thumb: typeof it.thumb === "string" && it.thumb.startsWith("data:image/") && it.thumb.length <= MAX_THUMB_BYTES ? it.thumb : ""
		});
	}
	const folder = typeof r.folder === "string" && isAbsolute(r.folder) ? r.folder : null;
	const folderRight = typeof r.folderRight === "string" && isAbsolute(r.folderRight) ? r.folderRight : null;
	const folders = r.source === "folders" && folder !== null && folderRight !== null;
	const legacyFast = r.interval === "minutes5";
	return {
		enabled: r.enabled === true,
		source: folders ? "folders" : r.source === "folder" && folder !== null ? "folder" : "pool",
		folder,
		folderCount: typeof r.folderCount === "number" && isFinite(r.folderCount) && r.folderCount > 0 ? Math.floor(r.folderCount) : 0,
		folderRight,
		folderRightCount: typeof r.folderRightCount === "number" && isFinite(r.folderRightCount) && r.folderRightCount > 0 ? Math.floor(r.folderRightCount) : 0,
		mode: r.mode === "order" ? "order" : "shuffle",
		interval: legacyFast ? "minutes" : r.interval === "reload" || r.interval === "minutes" || r.interval === "weekly" ? r.interval : "daily",
		intervalMinutes: clamp(r.intervalMinutes, INTERVAL_MINUTES_MIN, INTERVAL_MINUTES_MAX, legacyFast ? 5 : DEFAULT_CONFIG.rotation.intervalMinutes),
		dual: r.dual === true,
		laneItems: Array.isArray(r.laneItems) ? r.laneItems.filter((n) => typeof n === "string" && n.length > 0).slice(0, 2) : [],
		current: typeof r.current === "number" && isFinite(r.current) && r.current >= 0 ? Math.floor(r.current) : 0,
		items,
		lastRotate: typeof r.lastRotate === "string" ? r.lastRotate : null
	};
}
function normalizeSchedule(raw) {
	const r = raw ?? {};
	return {
		enabled: r.enabled === true,
		mode: r.mode === "system" ? "system" : "time",
		dayProfile: typeof r.dayProfile === "string" ? r.dayProfile : null,
		nightProfile: typeof r.nightProfile === "string" ? r.nightProfile : null,
		dayStart: typeof r.dayStart === "string" && HHMM_RE.test(r.dayStart) ? r.dayStart : DEFAULT_CONFIG.schedule.dayStart,
		nightStart: typeof r.nightStart === "string" && HHMM_RE.test(r.nightStart) ? r.nightStart : DEFAULT_CONFIG.schedule.nightStart
	};
}
async function ensureDir() {
	try {
		await mkdir(dataDir(), { recursive: true });
	} catch (e) {
		console.warn(`dsh-any-background: cannot create data dir "${dataDir()}"`, e);
	}
}
let configCacheKey = null;
let configCacheValue = null;
function dropConfigCache() {
	configCacheKey = null;
	configCacheValue = null;
}
async function readConfig() {
	await ensureDir();
	const file = configPath();
	let text;
	let key;
	try {
		const st = await stat(file);
		key = {
			mtimeMs: st.mtimeMs,
			size: st.size
		};
		if (configCacheKey !== null && configCacheValue !== null && configCacheKey.mtimeMs === key.mtimeMs && configCacheKey.size === key.size) return configCacheValue;
		text = await readFile(file, "utf8");
	} catch {
		dropConfigCache();
		return { ...DEFAULT_CONFIG };
	}
	try {
		const parsed = normalizeConfig(JSON.parse(text));
		configCacheKey = key;
		configCacheValue = parsed;
		return parsed;
	} catch (e) {
		try {
			const into = `${file}.corrupt-${Date.now()}`;
			await rename(file, into);
			console.warn(`dsh-any-background: theme-config.json was corrupt, archived to "${into}" and reset to defaults`, e);
		} catch {}
		dropConfigCache();
		return { ...DEFAULT_CONFIG };
	}
}
const LEGACY_CONFIG_KEYS = /* @__PURE__ */ new Set(["opacity"]);
const warnedConfigKeys = /* @__PURE__ */ new Set();
function warnUnknownConfigKeys(raw, normalized) {
	if (raw === null || typeof raw !== "object") return;
	const r = raw;
	const warn = (id) => {
		if (warnedConfigKeys.has(id)) return;
		warnedConfigKeys.add(id);
		console.warn(`dsh-any-background: ignoring unknown config field "${id}" (declared in one half only?)`);
	};
	const known = new Set(Object.keys(normalized));
	for (const key of Object.keys(r)) {
		if (known.has(key) || LEGACY_CONFIG_KEYS.has(key)) continue;
		warn(key);
	}
	for (const group of [
		"blurs",
		"opacities",
		"strokes"
	]) {
		const got = r[group];
		if (got === null || typeof got !== "object") continue;
		const have = new Set(Object.keys(normalized[group]));
		for (const key of Object.keys(got)) if (!have.has(key)) warn(`${group}.${key}`);
	}
}
async function writeConfig(config) {
	await ensureDir();
	const tmp = `${configPath()}.tmp`;
	try {
		const normalized = normalizeConfig(config);
		warnUnknownConfigKeys(config, normalized);
		await writeFile(tmp, JSON.stringify(normalized, null, 2), "utf8");
		await rename(tmp, configPath());
		dropConfigCache();
		return true;
	} catch (e) {
		console.error(`dsh-any-background: failed to write "${CONFIG_FILE}"`, e);
		try {
			await rm(tmp, { force: true });
		} catch {}
		return false;
	}
}
/** The wallpaper slot is served over HTTP (never shipped as base64 inside the
*  read RPC): the browser decodes it natively through the same pipeline as any
*  <img>, so boot only transfers a tiny URL instead of the whole image. */
async function wallpaperServeUrl() {
	try {
		return (await stat(wallpaperPath())).size > 0 ? WALLPAPER_ROUTE : null;
	} catch {
		return null;
	}
}
/** Dual mode's right pane, null when nothing has been painted there yet. */
async function wallpaperRightServeUrl() {
	try {
		return (await stat(wallpaperRightPath())).size > 0 ? WALLPAPER_RIGHT_ROUTE : null;
	} catch {
		return null;
	}
}
/** Persist a wallpaper (null removes it); false keeps the previous file. */
async function writeWallpaper(dataUrl) {
	await ensureDir();
	try {
		if (dataUrl === null) {
			await rm(wallpaperPath(), { force: true });
			return true;
		}
		const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
		if (!m) return false;
		await writeFile(wallpaperPath(), Buffer.from(m[1], "base64"));
		return true;
	} catch (e) {
		console.error(`dsh-any-background: failed to write "${WALLPAPER_FILE}"`, e);
		return false;
	}
}
/** Sniff an image's MIME from its leading magic bytes (defaults to JPEG). */
function sniffImageMime(buf) {
	if (buf.length >= 4 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "image/png";
	if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return "image/jpeg";
	if (buf.length >= 6 && buf[0] === 71 && buf[1] === 73 && buf[2] === 70) return "image/gif";
	if (buf.length >= 12 && buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70 && buf[8] === 87 && buf[9] === 69 && buf[10] === 66 && buf[11] === 80) return "image/webp";
	return "image/jpeg";
}
/** True when the leading bytes are a container the serve route knows how to
*  sniff. The Content-Type only reflects what the server claims; validating the
*  bytes themselves rejects a mislabeled or hostile payload with a clear error
*  instead of persisting a file that renders as a broken image. */
function isImageBytes(buf) {
	if (buf.length >= 4 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return true;
	if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return true;
	if (buf.length >= 6 && buf[0] === 71 && buf[1] === 73 && buf[2] === 70) return true;
	if (buf.length >= 12 && buf[0] === 82 && buf[1] === 73 && buf[2] === 70 && buf[3] === 70 && buf[8] === 87 && buf[9] === 69 && buf[10] === 66 && buf[11] === 80) return true;
	return false;
}
/** Download a wallpaper from a network URL and persist it into the local
*  wallpaper.jpg slot (replacing whatever was stored), so type switches and
*  rotation keep working through the single active slot. The response carries
*  the serve URL, never the bytes. null removes the wallpaper.
*  Returns { ok, wallpaperUrl?, error? }. */
async function writeWallpaperFromUrl(url) {
	if (url === null) {
		const ok = await writeWallpaper(null);
		return {
			ok,
			wallpaperUrl: null,
			error: ok ? void 0 : "remove failed"
		};
	}
	let u;
	try {
		u = new URL(url);
	} catch {
		return {
			ok: false,
			error: "invalid url"
		};
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return {
		ok: false,
		error: "unsupported scheme"
	};
	let res;
	try {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), WALLPAPER_FETCH_TIMEOUT);
		try {
			res = await fetch(url, {
				redirect: "follow",
				signal: ctl.signal
			});
		} finally {
			clearTimeout(timer);
		}
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error && e.name === "AbortError" ? "timeout" : "network error"
		};
	}
	if (!res.ok) return {
		ok: false,
		error: `http ${res.status}`
	};
	const ct = res.headers.get("content-type") ?? "";
	if (ct && !/^image\//.test(ct)) return {
		ok: false,
		error: "not an image"
	};
	let buf;
	try {
		const arr = await res.arrayBuffer();
		if (arr.byteLength === 0) return {
			ok: false,
			error: "empty response"
		};
		if (arr.byteLength > WALLPAPER_FETCH_MAX) return {
			ok: false,
			error: "too large"
		};
		buf = Buffer.from(arr);
	} catch {
		return {
			ok: false,
			error: "read failed"
		};
	}
	if (!isImageBytes(buf)) return {
		ok: false,
		error: "not an image"
	};
	await ensureDir();
	try {
		await writeFile(wallpaperPath(), buf);
	} catch (e) {
		console.error("dsh-any-background: failed to write the downloaded wallpaper", e);
		return {
			ok: false,
			error: "write failed"
		};
	}
	return {
		ok: true,
		wallpaperUrl: WALLPAPER_ROUTE
	};
}
const rotationDir = () => dshHomePath(DATA_DIR, ROTATION_DIR);
async function ensureRotationDir() {
	try {
		await mkdir(rotationDir(), { recursive: true });
	} catch {}
}
function imageExtFor(mime) {
	if (mime === "image/png") return "png";
	if (mime === "image/gif") return "gif";
	if (mime === "image/webp") return "webp";
	return "jpg";
}
/** Accept only an inline base64 image data URL (same fence as writeWallpaper). */
function decodeImageDataUrl(dataUrl) {
	if (typeof dataUrl !== "string") return null;
	const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
	if (!m) return null;
	const buf = Buffer.from(m[1], "base64");
	return buf.length > 0 ? buf : null;
}
/** Persist a thumbnail string only when it is a small inline image data URL. */
function sanitizeThumb(thumb) {
	return typeof thumb === "string" && thumb.startsWith("data:image/") && thumb.length <= MAX_THUMB_BYTES ? thumb : "";
}
async function handleRotationAdd(payload) {
	const buf = decodeImageDataUrl(payload?.dataUrl);
	if (buf === null) return {
		ok: false,
		error: "invalid image"
	};
	const thumb = sanitizeThumb(payload?.thumb);
	await ensureDir();
	await ensureRotationDir();
	if ((await readConfig()).rotation.items.length >= MAX_ROTATION_ITEMS) return {
		ok: false,
		error: "too many items"
	};
	const file = `wp-${Date.now().toString(36)}.${imageExtFor(sniffImageMime(buf))}`;
	try {
		await writeFile(dshHomePath(DATA_DIR, ROTATION_DIR, file), buf);
	} catch (e) {
		console.error("dsh-any-background: failed to write a rotation wallpaper", e);
		return {
			ok: false,
			error: "write failed"
		};
	}
	const fresh = await readConfig();
	fresh.rotation.items.push({
		file,
		thumb
	});
	if (!await writeConfig(fresh)) return {
		ok: false,
		error: "config write failed"
	};
	return {
		ok: true,
		index: fresh.rotation.items.length - 1,
		items: fresh.rotation.items
	};
}
async function handleRotationRemove(payload) {
	const idx = payload?.index;
	if (typeof idx !== "number" || !isFinite(idx)) return {
		ok: false,
		error: "invalid index"
	};
	const cfg = await readConfig();
	const i = Math.floor(idx);
	if (i < 0 || i >= cfg.rotation.items.length) return {
		ok: false,
		error: "not found"
	};
	const [removed] = cfg.rotation.items.splice(i, 1);
	cfg.rotation.current = Math.max(0, Math.min(cfg.rotation.current >= i ? cfg.rotation.current - 1 : cfg.rotation.current, Math.max(0, cfg.rotation.items.length - 1)));
	if (removed !== void 0) try {
		await rm(dshHomePath(DATA_DIR, ROTATION_DIR, removed.file), { force: true });
	} catch {}
	if (!await writeConfig(cfg)) return {
		ok: false,
		error: "config write failed"
	};
	return {
		ok: true,
		items: cfg.rotation.items
	};
}
/** Activate a rotation item: copy its bytes over the active wallpaper slot and
*  return the serve URL so the client applies it live (bytes never round-trip
*  through the RPC response). In folder mode the index addresses the current
*  listing of the picked directory instead of the stored pool. */
async function handleRotationSet(payload) {
	const idx = payload?.index;
	if (typeof idx !== "number" || !isFinite(idx)) return {
		ok: false,
		error: "invalid index"
	};
	const cfg = await readConfig();
	if (cfg.rotation.source !== "pool") return {
		ok: false,
		error: "folder mode ignores item indexes"
	};
	const n = cfg.rotation.items.length;
	const i = Math.floor(idx);
	const item = cfg.rotation.items[i];
	if (item === void 0) return {
		ok: false,
		error: "not found"
	};
	const right = pickRotationPair(n, i, cfg.rotation.mode, cfg.rotation.dual).right;
	const rightItem = right >= 0 ? cfg.rotation.items[right] : void 0;
	let buf;
	try {
		buf = await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, item.file));
	} catch {
		return {
			ok: false,
			error: "file missing"
		};
	}
	try {
		await writeFile(wallpaperPath(), buf);
		if (rightItem !== void 0) await writeFile(wallpaperRightPath(), await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, rightItem.file)));
	} catch (e) {
		console.error("dsh-any-background: failed to activate a rotation wallpaper", e);
		return {
			ok: false,
			error: "write failed"
		};
	}
	return {
		ok: true,
		wallpaperUrl: WALLPAPER_ROUTE,
		wallpaperRightUrl: rightItem === void 0 ? void 0 : WALLPAPER_RIGHT_ROUTE
	};
}
/** Bare image file name, or null. The names come from the operator's own
*  directory, so dots and spaces are allowed; separators never are. */
function safeImageName(name) {
	if (typeof name !== "string" || name.length === 0 || name.length > 255) return null;
	if (name.includes("/") || name.includes("\\")) return null;
	return /\.(jpg|jpeg|png|gif|webp)$/i.test(name) ? name : null;
}
/** Images directly inside `dir`, in name order, capped at MAX_FOLDER_IMAGES.
*  Exported as a check seam for the folder-mode listing rules. */
async function listFolderImages(dir) {
	return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && safeImageName(e.name) !== null).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, MAX_FOLDER_IMAGES);
}
/** Next candidate index over `n` candidates: order walks forward, shuffle never
*  repeats the current pick when there is a choice. Exported as a check seam —
*  the browser half mirrors this rule for a due check. */
function pickRotationIndex(n, current, mode) {
	if (n <= 0) return -1;
	if (mode === "shuffle" && n > 1) {
		let idx = current;
		while (idx === current) idx = Math.floor(Math.random() * n);
		return idx;
	}
	return (current % n + n + 1) % n;
}
/** The index a dual step paints on the right, given the index it just landed on
*  for the left pane. -1 means "no right pane". This is the SECOND advance of
*  ONE rotation, not a second rotation: order steps to the very next name, and
*  shuffle walks a non-zero distance from `left`. Walking from `left` rather
*  than drawing again is what keeps the two panes from ever colliding — the
*  shuffle RNG is unseeded, so two independent draws can land on the same name. */
function nextLaneIndex(n, left, mode) {
	if (n <= 1 || left < 0) return -1;
	return mode === "shuffle" ? (left + 1 + Math.floor(Math.random() * (n - 1))) % n : (left + 1) % n;
}
/** One dual rotation step: the index for the left pane and the index for the
*  right pane, or -1 for "no right pane" (dual off, or only one candidate).
*  Deliberately ONE draw, not two rotations: `left` is the ordinary next index,
*  and `right` is the index the SAME step lands on when advanced a second time —
*  the user's framing, "the same rotation advanced twice". When the pool holds
*  a single picture there is no second index to reach and the right pane drops
*  back to nothing rather than duplicating the left one. */
function pickRotationPair(n, current, mode, dual) {
	const left = pickRotationIndex(n, current, mode);
	if (!dual) return {
		left,
		right: -1
	};
	return {
		left,
		right: nextLaneIndex(n, left, mode)
	};
}
/** The two file names a dual step just painted, in `items` order, for the
*  client mirror's `laneItems`. Empty when the pool cannot fill both panes. */
function laneNames(items, pair) {
	const names = [];
	const a = items[pair.left];
	if (a !== void 0) names.push(a.file);
	const b = pair.right >= 0 ? items[pair.right] : void 0;
	if (b !== void 0 && b.file !== a?.file) names.push(b.file);
	return names;
}
/** The host's directory-chooser capability, or null when no picker is mounted
*  (an older host, or a remote one composed without the seam). Read per call:
*  the `auto` backend decides its side at boot and the answer is cheap. */
function directoryPickerCapability(ctx) {
	try {
		const picker = ctx?.get?.("directoryPicker");
		if (picker === null || typeof picker !== "object" || typeof picker.capability !== "function") return null;
		const cap = picker.capability();
		return cap !== null && typeof cap === "object" && typeof cap.kind === "string" ? cap : null;
	} catch {
		return null;
	}
}
/** "Switch now": the operator pressed the button, so the cadence is skipped and
*  whichever source is in charge advances. Folder mode copies its next file and
*  hands the new rotation back. The pool path goes through the same due check
*  the automatic path uses — with `interval: 'reload'` that is always true, so
*  the button still advances — and then reports whether the right pane is now
*  painted, so the browser half can show or drop the second lane without
*  polling the file. */
async function advanceForCaller() {
	const cfg = await readConfig();
	if (cfg.rotation.source === "folder" || cfg.rotation.source === "folders") {
		const r = await advanceFolderRotation(true);
		if (!r.ok) return {
			ok: false,
			wallpaperRightUrl: await wallpaperRightServeUrl() ?? void 0
		};
		return {
			ok: true,
			rotation: r.rotation,
			wallpaperUrl: WALLPAPER_ROUTE,
			wallpaperRightUrl: (r.rotation?.laneItems.length ?? 0) > 1 ? WALLPAPER_RIGHT_ROUTE : void 0
		};
	}
	if (!await advanceRotationIfDue()) return {
		ok: false,
		wallpaperRightUrl: await wallpaperRightServeUrl() ?? void 0
	};
	return {
		ok: true,
		rotation: (await readConfig()).rotation,
		wallpaperUrl: WALLPAPER_ROUTE,
		wallpaperRightUrl: await wallpaperRightServeUrl() ?? void 0
	};
}
/** Open the host's native folder chooser and adopt the picked directory as the
*  rotation source. Only a `native` capability can answer (the browse backend
*  serves listing primitives for an in-app browser instead); the client hides
*  the button when the kind is anything else. `lane` says which side of a dual
*  wall the pick belongs to: the LEFT lane alone is the single-folder mode, and
*  the right lane only ever exists alongside a left folder, so a right pick
*  without one is refused rather than stored as a half-configured pair. When
*  rotation is already on AND both lanes have a directory the pair is copied
*  over the wallpaper slots straight away, so the operator sees the finished
*  wall; a lone folder is stored but never previewed, because half a wall
*  reads as a bug. */
async function handleRotationPickFolder(ctx, lane = "left") {
	const cap = directoryPickerCapability(ctx);
	if (cap === null || cap.kind !== "native" || typeof cap.pick !== "function") return {
		ok: false,
		error: "no folder picker"
	};
	let picked;
	try {
		picked = await cap.pick(new AbortController().signal);
	} catch (e) {
		console.warn("dsh-any-background: the folder chooser failed", e);
		return {
			ok: false,
			error: "picker failed"
		};
	}
	if (typeof picked !== "string") return {
		ok: false,
		error: "cancelled"
	};
	if (!isAbsolute(picked)) return {
		ok: false,
		error: "invalid path"
	};
	let names;
	try {
		names = await listFolderImages(picked);
	} catch {
		return {
			ok: false,
			error: "unreadable"
		};
	}
	if (names.length === 0) return {
		ok: false,
		error: "no images"
	};
	const cfg = await readConfig();
	const prev = cfg.rotation;
	if (lane === "right" && prev.folder === null) return {
		ok: false,
		error: "no left folder"
	};
	const folderRight = lane === "right" ? picked : prev.folderRight;
	const folderRightCount = lane === "right" ? names.length : prev.folderRightCount;
	const folder = lane === "right" ? prev.folder : picked;
	const folderCount = lane === "right" ? prev.folderCount : names.length;
	const rotation = {
		...prev,
		source: folderRight !== null ? "folders" : "folder",
		folder,
		folderCount,
		folderRight,
		folderRightCount,
		current: 0,
		lastRotate: null
	};
	if (rotation.enabled && rotation.folder !== null && rotation.folderRight !== null) try {
		const firstLeft = (lane === "right" ? await listFolderImages(rotation.folder) : names)[0];
		const firstRight = (await listFolderImages(rotation.folderRight))[0];
		if (firstLeft !== void 0) await writeFile(wallpaperPath(), await readFile(join(rotation.folder, firstLeft)));
		if (firstRight !== void 0) await writeFile(wallpaperRightPath(), await readFile(join(rotation.folderRight, firstRight)));
		rotation.laneItems = firstRight === void 0 ? [] : [firstLeft, firstRight];
		rotation.lastRotate = (/* @__PURE__ */ new Date()).toISOString();
	} catch (e) {
		console.warn("dsh-any-background: could not preview the picked folder", e);
	}
	if (!await writeConfig({
		...cfg,
		rotation
	})) return {
		ok: false,
		error: "config write failed"
	};
	return {
		ok: true,
		folder: picked,
		count: names.length,
		previewed: rotation.lastRotate !== null,
		rotation
	};
}
/** Advance a folder rotation to its next candidate: the chosen file is copied
*  over the wallpaper slot. `force` skips the cadence test (the operator pressed
*  "switch now"); the automatic path leaves it in place. The rotation this
*  landed on travels back to the caller, whose in-memory mirror would otherwise
*  save its stale index back over the advance (order mode would stick on one
*  file). A no-op while the pool is the source. */
async function advanceFolderRotation(force) {
	const rot = (await readConfig()).rotation;
	if (!rot.enabled) return { ok: false };
	const dualFolders = rot.source === "folders";
	if (!dualFolders && rot.source !== "folder") return { ok: false };
	if (rot.folder === null) return { ok: false };
	if (dualFolders && rot.folderRight === null) return { ok: false };
	const now = /* @__PURE__ */ new Date();
	if (!force && !rotationIsDue(rot, now)) return { ok: false };
	let names;
	try {
		names = await listFolderImages(rot.folder);
	} catch {
		return { ok: false };
	}
	if (names.length === 0) return { ok: false };
	const idx = rot.lastRotate === null ? Math.min(Math.max(rot.current, 0), names.length - 1) : pickRotationIndex(names.length, rot.current, rot.mode);
	const name = names[idx];
	if (name === void 0) return { ok: false };
	let rightName;
	let rightCount = rot.folderRightCount;
	if (dualFolders) {
		let rightNames;
		try {
			rightNames = await listFolderImages(rot.folderRight);
		} catch {
			return { ok: false };
		}
		if (rightNames.length === 0) return { ok: false };
		rightCount = rightNames.length;
		const rightShown = rot.laneItems[1];
		const rightPrev = rightShown !== void 0 ? rightNames.indexOf(rightShown) : -1;
		const rightIdx = rot.lastRotate === null ? rightPrev >= 0 ? rightPrev : 0 : pickRotationIndex(rightNames.length, rightPrev, rot.mode);
		rightName = rightNames[rightIdx];
		if (rightName === void 0) return { ok: false };
	} else if (rot.dual) {
		const right = nextLaneIndex(names.length, idx, rot.mode);
		rightName = right >= 0 ? names[right] : void 0;
	}
	try {
		await writeFile(wallpaperPath(), await readFile(join(rot.folder, name)));
		if (rightName !== void 0) {
			const rightDir = dualFolders ? rot.folderRight : rot.folder;
			await writeFile(wallpaperRightPath(), await readFile(join(rightDir, rightName)));
		}
	} catch (e) {
		console.error("dsh-any-background: failed to activate a folder wallpaper", e);
		return { ok: false };
	}
	const nextLaneItems = rightName === void 0 ? [name] : [name, rightName];
	const advanced = {
		...rot,
		current: idx,
		folderCount: names.length,
		folderRightCount: rightCount,
		laneItems: nextLaneItems,
		lastRotate: now.toISOString()
	};
	if (!await writeConfig({
		...await readConfig(),
		rotation: advanced
	})) return { ok: false };
	return {
		ok: true,
		rotation: advanced
	};
}
/** Drop a partial upload's temp file once its sink is really closed. Windows
*  refuses to unlink a file that still has an open handle, so removing it in the
*  same tick as `out.destroy()` silently fails and leaves the aborted transfer
*  on disk (up to the full limit) until some later upload overwrites it. */
function rmWhenClosed(out, tmp) {
	const drop = () => {
		rm(tmp, { force: true });
	};
	if (out.closed === true) drop();
	else out.once("close", drop);
}
/** Reject an oversized upload with a real status and tear the transfer down.
*  The bare req.destroy()+fail() path left the client holding a network error
*  with no way to tell "too large" from "connection died". The body is machine
*  readable (`error` + the enforced `limit`) so the panel can phrase the
*  refusal in the user's own language, with `message` kept for logs. */
function rejectOversizedUpload(req, res, fail, limit) {
	try {
		res.writeHead(413, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			ok: false,
			error: "too large",
			limit,
			message: `too large (limit ${limit})`
		}));
	} catch {}
	fail();
	try {
		req.destroy();
	} catch {}
}
/** Stream a stored wallpaper slot: sniffed MIME, no caching (uploads and
*  rotation replace the file in place). Shared by both panes — the left slot
*  and dual mode's right slot are the same kind of artifact. */
async function serveWallpaperFile(req, res, file) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			ok: false,
			error: "wallpaper route only serves GET/HEAD"
		}));
		return;
	}
	try {
		const st = await stat(file);
		if (st.size === 0) {
			res.writeHead(404);
			res.end();
			return;
		}
		const mime = sniffImageMime(await new Promise((resolve, reject) => {
			const chunks = [];
			const s = createReadStream(file, {
				start: 0,
				end: 15
			});
			s.on("data", (c) => chunks.push(c));
			s.on("end", () => resolve(Buffer.concat(chunks)));
			s.on("error", reject);
		}));
		res.writeHead(200, {
			"Content-Type": mime,
			"Content-Length": st.size,
			"Cache-Control": "no-store"
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		createReadStream(file).pipe(res);
	} catch {
		res.writeHead(404);
		res.end("no wallpaper stored");
	}
}
const serveWallpaper = (req, res) => serveWallpaperFile(req, res, wallpaperPath());
const serveWallpaperRight = (req, res) => serveWallpaperFile(req, res, wallpaperRightPath());
/** Accept a raw wallpaper upload (POST): pipe the body straight into the
*  wallpaper slot — no base64 inflation, original pixels preserved. */
async function handleWallpaperUpload(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}
	if (!(typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "").split(";")[0].trim().startsWith("image/")) {
		req.resume();
		res.writeHead(415, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			ok: false,
			error: "unsupported media type, expected image/*"
		}));
		return;
	}
	try {
		await ensureDir();
		const tmp = dshHomePath(DATA_DIR, UPLOAD_TMP);
		const out = createWriteStream(tmp);
		let received = 0;
		let failed = false;
		const fail = () => {
			if (failed) return;
			failed = true;
			out.destroy();
			rmWhenClosed(out, tmp);
		};
		req.on("aborted", fail);
		req.on("error", fail);
		out.on("error", () => {
			fail();
			try {
				res.writeHead(500);
				res.end();
			} catch {}
		});
		req.on("data", (chunk) => {
			if (failed) return;
			received += chunk.byteLength;
			if (received > WALLPAPER_UPLOAD_MAX) rejectOversizedUpload(req, res, fail, "100 MB");
		});
		req.pipe(out);
		out.on("finish", async () => {
			if (failed) return;
			try {
				if (received === 0) {
					fail();
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: "empty upload"
					}));
					return;
				}
				await rm(wallpaperPath(), { force: true });
				await rename(tmp, wallpaperPath());
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					ok: true,
					wallpaperUrl: WALLPAPER_ROUTE
				}));
			} catch (e) {
				console.error("dsh-any-background: failed to finalize the wallpaper upload", e);
				rm(tmp, { force: true });
				try {
					res.writeHead(500);
					res.end();
				} catch {}
			}
		});
	} catch (e) {
		console.error("dsh-any-background: failed to accept the wallpaper upload", e);
		try {
			res.writeHead(500);
			res.end();
		} catch {}
	}
}
/** Stream the stored custom font: sniffed MIME, no caching (uploads replace
*  the file in place). Fonts need no Range support — the browser fetches once. */
async function serveFont(req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			ok: false,
			error: "font route only serves GET/HEAD"
		}));
		return;
	}
	try {
		const found = await findFontFile();
		if (found === null) {
			res.writeHead(404);
			res.end("no custom font stored");
			return;
		}
		const st = await stat(found.path);
		res.writeHead(200, {
			"Content-Type": found.mime,
			"Content-Length": st.size,
			"Cache-Control": "no-store"
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		createReadStream(found.path).pipe(res);
	} catch (e) {
		console.error("dsh-any-background: failed to serve the custom font", e);
		try {
			res.writeHead(500);
			res.end();
		} catch {}
	}
}
/** Accept a raw font upload (POST): pipe the body into a temp file, sniff the
*  container format from its magic bytes (rejecting anything that is not a
*  recognizable font), then rename it into the format-derived slot and record
*  the MIME in the config so serve/find resolve immediately. */
async function handleFontUpload(req, res) {
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}
	try {
		await ensureDir();
		const tmp = dshHomePath(DATA_DIR, FONT_UPLOAD_TMP);
		const out = createWriteStream(tmp);
		let received = 0;
		let failed = false;
		const fail = () => {
			if (failed) return;
			failed = true;
			out.destroy();
			rmWhenClosed(out, tmp);
		};
		req.on("aborted", fail);
		req.on("error", fail);
		out.on("error", () => {
			fail();
			try {
				res.writeHead(500);
				res.end();
			} catch {}
		});
		req.on("data", (chunk) => {
			if (failed) return;
			received += chunk.byteLength;
			if (received > FONT_UPLOAD_MAX) rejectOversizedUpload(req, res, fail, "100 MB");
		});
		req.pipe(out);
		out.on("finish", async () => {
			if (failed) return;
			try {
				if (received === 0) {
					fail();
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: "empty upload"
					}));
					return;
				}
				const mime = sniffFontMime(await new Promise((resolve, reject) => {
					const chunks = [];
					const s = createReadStream(tmp, {
						start: 0,
						end: 15
					});
					s.on("data", (c) => chunks.push(c));
					s.on("end", () => resolve(Buffer.concat(chunks)));
					s.on("error", reject);
				}));
				if (mime === null) {
					fail();
					res.writeHead(415, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: "not a font (expected ttf/otf/woff/woff2)"
					}));
					return;
				}
				const target = fontPathFor(mime);
				for (const name of FONT_CANDIDATES) {
					const p = dshHomePath(DATA_DIR, name);
					if (p !== target) await rm(p, { force: true });
				}
				await rm(target, { force: true });
				await rename(tmp, target);
				const cfg = await readConfig();
				if (cfg.fontMime !== mime) {
					cfg.fontMime = mime;
					await writeConfig(cfg);
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					ok: true,
					fontUrl: FONT_ROUTE,
					mime
				}));
			} catch (e) {
				console.error("dsh-any-background: failed to finalize the font upload", e);
				rm(tmp, { force: true });
				try {
					res.writeHead(500);
					res.end();
				} catch {}
			}
		});
	} catch (e) {
		console.error("dsh-any-background: failed to accept the font upload", e);
		try {
			res.writeHead(500);
			res.end();
		} catch {}
	}
}
/** Remove every stored font variant and clear the recorded MIME. */
async function removeFontFile() {
	try {
		for (const name of FONT_CANDIDATES) await rm(dshHomePath(DATA_DIR, name), { force: true });
		await rm(dshHomePath(DATA_DIR, FONT_UPLOAD_TMP), { force: true });
		const cfg = await readConfig();
		if (cfg.fontMime !== null) {
			cfg.fontMime = null;
			await writeConfig(cfg);
		}
		return true;
	} catch (e) {
		console.error("dsh-any-background: failed to remove the custom font", e);
		return false;
	}
}
const NS = "dshAnyBackground";
const RPC_CHANNEL = "/dsh-any-background";
const RPC_BODY_MAX = 314572800;
/** ISO week key — mirrors the client's rotationDue so daily/weekly cadence
*  decisions agree across both halves. */
function isoWeekKey(d) {
	const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const day = t.getUTCDay() || 7;
	t.setUTCDate(t.getUTCDate() + 4 - day);
	const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
	const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
	return `${t.getUTCFullYear()}-W${week}`;
}
/** Wall-clock gap of a `minutes` rotation, in ms. Guarded rather than trusted:
*  a config edited by hand (or written by an older half) can carry anything,
*  and the value feeds a timer the client re-arms on. */
function rotationGapMs(rot) {
	return clamp(rot.intervalMinutes, INTERVAL_MINUTES_MIN, INTERVAL_MINUTES_MAX, DEFAULT_CONFIG.rotation.intervalMinutes) * 6e4;
}
/** Whether a rotation is due at `now`: `reload` always is, a missing/unparsable
*  stamp is treated as never rotated, `minutes` compares a wall-clock gap, and
*  the dated cadences compare calendar day / ISO week. */
function rotationIsDue(rot, now) {
	if (rot.interval === "reload") return true;
	const last = rot.lastRotate !== null ? new Date(rot.lastRotate) : null;
	if (last === null || isNaN(last.getTime())) return true;
	if (rot.interval === "minutes") return now.getTime() - last.getTime() >= rotationGapMs(rot);
	return rot.interval === "daily" ? last.toDateString() !== now.toDateString() : isoWeekKey(last) !== isoWeekKey(now);
}
/** Advance the rotation pool when its cadence is due: pick the next item,
*  copy it over the active wallpaper slot, and persist the rotation state.
*  Runs inside `read` so a reload restores the NEW wallpaper directly — the
*  old one never reaches the screen. The client's maybeRotate stays as a
*  fallback and skips when this already advanced (the `rotated` flag). */
async function advanceRotationIfDue() {
	const rot = (await readConfig()).rotation;
	if (rot.source === "folder" || rot.source === "folders") return (await advanceFolderRotation(false)).ok;
	if (!rot.enabled || rot.items.length === 0) return false;
	const now = /* @__PURE__ */ new Date();
	if (!rotationIsDue(rot, now)) return false;
	const pair = pickRotationPair(rot.items.length, rot.current, rot.mode, rot.dual);
	const item = rot.items[pair.left];
	if (item === void 0) return false;
	try {
		await writeFile(wallpaperPath(), await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, item.file)));
		if (pair.right >= 0) {
			const second = rot.items[pair.right];
			if (second !== void 0) await writeFile(wallpaperRightPath(), await readFile(dshHomePath(DATA_DIR, ROTATION_DIR, second.file)));
		}
	} catch (e) {
		console.error("dsh-any-background: failed to advance the rotation pool", e);
		return false;
	}
	if (!await writeConfig({
		...await readConfig(),
		rotation: {
			...rot,
			current: pair.left,
			laneItems: laneNames(rot.items, pair),
			lastRotate: now.toISOString()
		}
	})) return false;
	return true;
}
/** Dispatch one decoded RPC method to the matching persistence routine and
*  return the wire `result` half of the server-response envelope. */
async function handleRpcMethod(endpoint, payload, hostInfo, ctx) {
	const method = endpoint.slice(`${NS}/`.length);
	try {
		switch (method) {
			case "read": {
				const rotated = await advanceRotationIfDue();
				const config = await readConfig();
				const firstRun = !await exists(configPath());
				if (firstRun) await writeConfig(config);
				return {
					ok: true,
					value: {
						config,
						wallpaperUrl: await wallpaperServeUrl(),
						wallpaperRightUrl: await wallpaperRightServeUrl(),
						fontUrl: await fontUrl(),
						rotated,
						firstRun,
						folderPicker: directoryPickerCapability(ctx)?.kind === "native",
						host: await hostInfo
					}
				};
			}
			case "writeConfig": return {
				ok: true,
				value: await writeConfig(payload?.config ?? {})
			};
			case "setWallpaper": return {
				ok: true,
				value: await writeWallpaper(payload?.dataUrl ?? null)
			};
			case "setWallpaperUrl": return {
				ok: true,
				value: await writeWallpaperFromUrl(payload?.url ?? null)
			};
			case "rotationAdd":
				if (payload !== null && typeof payload === "object" && payload.source !== "folder") {
					const cfg = await readConfig();
					if (cfg.rotation.source !== "pool") await writeConfig({
						...cfg,
						rotation: {
							...cfg.rotation,
							source: "pool",
							folder: null,
							folderCount: 0,
							folderRight: null,
							folderRightCount: 0
						}
					});
				}
				return {
					ok: true,
					value: await handleRotationAdd(payload)
				};
			case "rotationRemove": return {
				ok: true,
				value: await handleRotationRemove(payload)
			};
			case "rotationSet": return {
				ok: true,
				value: await handleRotationSet(payload)
			};
			case "rotationSetFolder": return {
				ok: true,
				value: await handleRotationPickFolder(ctx, payload?.lane === "right" ? "right" : "left")
			};
			case "rotationClearFolder": {
				const cfg = await readConfig();
				return {
					ok: true,
					value: await writeConfig({
						...cfg,
						rotation: {
							...cfg.rotation,
							source: "pool",
							folder: null,
							folderCount: 0,
							folderRight: null,
							folderRightCount: 0,
							current: 0,
							laneItems: [],
							lastRotate: null
						}
					}) ? { ok: true } : {
						ok: false,
						error: "config write failed"
					}
				};
			}
			case "rotationAdvance": return {
				ok: true,
				value: await advanceForCaller()
			};
			case "removeFont": return {
				ok: true,
				value: await removeFontFile()
			};
			default: return {
				ok: false,
				error: {
					code: "dsh-any-background/bad-request",
					message: `unknown endpoint ${endpoint}`,
					details: { issues: [] }
				}
			};
		}
	} catch (e) {
		return {
			ok: false,
			error: {
				code: "dsh-any-background/internal",
				message: e instanceof Error ? e.message : String(e),
				details: {}
			}
		};
	}
}
function apply(ctx) {
	const hostInfo = resolveHostInfo(ctx.profileContext?.installAnchor).catch((e) => {
		console.warn("dsh-any-background: host release detection failed, falling back to DOM probing", e);
		return UNKNOWN_HOST_INFO;
	});
	ctx.inject(["connection", "webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: RPC_CHANNEL,
			handler: async (req, res) => {
				const rejection = webCtx.connection.requestRejection(req);
				if (rejection !== void 0) {
					res.writeHead(rejection);
					res.end(rejection === 401 ? "unauthorized" : "forbidden");
					return;
				}
				if (req.method !== "POST") {
					res.writeHead(405, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: {
							code: "dsh-any-background/bad-request",
							message: "expected POST",
							details: {}
						}
					}));
					return;
				}
				const declaredLen = Number(req.headers["content-length"] ?? "");
				if (Number.isFinite(declaredLen) && declaredLen > RPC_BODY_MAX) {
					res.writeHead(413, {
						"Content-Type": "application/json",
						connection: "close"
					});
					res.end(JSON.stringify({
						ok: false,
						error: {
							code: "dsh-any-background/too-large",
							message: `body exceeds ${RPC_BODY_MAX} bytes; uploads must use the binary routes`,
							details: {}
						}
					}));
					return;
				}
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`) ? pathname.slice(20) : void 0;
				if (endpoint === void 0 || endpoint.length === 0) {
					res.writeHead(404);
					res.end();
					return;
				}
				const chunks = [];
				let received = 0;
				for await (const chunk of req) {
					const buf = chunk;
					received += buf.byteLength;
					if (received > RPC_BODY_MAX) {
						res.writeHead(413, { connection: "close" });
						res.end();
						req.destroy();
						return;
					}
					chunks.push(buf);
				}
				let env;
				try {
					env = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
				} catch {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: {
							code: "dsh-any-background/bad-request",
							message: "body is not JSON",
							details: {}
						}
					}));
					return;
				}
				if (env === null || typeof env !== "object" || env.type !== "client-request" || typeof env.rpcId !== "string" || typeof env.method !== "string") {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ok: false,
						error: {
							code: "dsh-any-background/bad-request",
							message: "invalid client-request envelope",
							details: {}
						}
					}));
					return;
				}
				if (env.method !== endpoint) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						type: "server-response",
						rpcId: env.rpcId,
						result: {
							ok: false,
							error: {
								code: "dsh-any-background/bad-request",
								message: `method ${env.method} does not match endpoint ${endpoint}`,
								details: { issues: [] }
							}
						}
					}));
					return;
				}
				const result = await handleRpcMethod(endpoint, env.payload, hostInfo, webCtx);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({
					type: "server-response",
					rpcId: env.rpcId,
					result
				}));
			}
		}), "dsh-any-background: rpc channel");
		const fenceUpload = (handler) => (req, res) => {
			const rejection = webCtx.connection.requestRejection(req);
			if (rejection !== void 0) {
				res.writeHead(rejection);
				res.end(rejection === 401 ? "unauthorized" : "forbidden");
				return;
			}
			handler(req, res);
		};
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: WALLPAPER_ROUTE,
			handler: serveWallpaper
		}), "dsh-any-background: wallpaper route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: WALLPAPER_RIGHT_ROUTE,
			handler: serveWallpaperRight
		}), "dsh-any-background: wallpaper right route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: WALLPAPER_UPLOAD_ROUTE,
			handler: fenceUpload(handleWallpaperUpload)
		}), "dsh-any-background: wallpaper upload route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: FONT_ROUTE,
			handler: serveFont
		}), "dsh-any-background: font route");
		webCtx.effect(() => webCtx.webServer.register({
			kind: "exact",
			path: FONT_UPLOAD_ROUTE,
			handler: fenceUpload(handleFontUpload)
		}), "dsh-any-background: font upload route");
	});
}
//#endregion
export { DEFAULT_CONFIG, apply, inject, listFolderImages, name, nextLaneIndex, pickRotationIndex, pickRotationPair, rotationGapMs, rotationIsDue };
