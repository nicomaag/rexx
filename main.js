// Node.js Puppeteer-Skript zur Buchungsautomatisierung (LOGIN & NAVIGATION UNVERÄNDERT)
// Bucht JEDE Zeile mit Saldo -8:00 direkt in der Buchungsliste – PRO TAG NUR EIN MAL:
//   - öffnet Formular aus der jeweiligen Tabellenzeile
//   - setzt Start- (Kommen) und Endzeit (Gehen)
//   - wählt Projekt (Remote/Office) über den globalen Dialog (jetzt: pro Wochentag aus ENV)
//   - speichert
// Debug: --debug [--slowmo=250]; Zeiten: --kommen=09:00 --gehen=18:00
//
// Wochentags-Konfiguration (Priorität):
// 1) WEEKDAY_MODE="Mon:Remote,Tue:Office,Wed:Remote,Thu:Office,Fri:Remote"
// 2) REMOTE_DAYS="Mon,Fri"  + OFFICE_DAYS="Tue,Wed,Thu"
// 3) Fallback: --mode=Remote|Office
//
// Akzeptierte Tags: Mon/Tue/Wed/Thu/Fri/Sat/Sun (auch Mo/Di/Mi/Do/Fr/Sa/So)

const puppeteer = require("puppeteer");
const minimist = require("minimist");
require("dotenv").config();

// === CLI-Parameter ===
const args = minimist(process.argv.slice(2));
const KOMMEN_TIME = args.kommen || "09:00";
const GEHEN_TIME = args.gehen || "18:00";
const DEFAULT_MODE = (args.mode || "Office").trim(); // Fallback, falls ENV nichts vorgibt

// Debug: mit --debug wird headless sichtbar und jede Aktion verlangsamt
const DEBUG = !!args.debug;
const SLOWMO = DEBUG ? parseInt(args.slowmo, 10) || 50 : 0;

// === ENV-Creds (UNVERÄNDERT) ===
const BENUTZERNAME = process.env.BENUTZERNAME;
const PASSWORT = process.env.PASSWORT;

if (!BENUTZERNAME || !PASSWORT) {
	console.error("❌ BENUTZERNAME oder PASSWORT fehlt!");
	process.exit(1);
}

// === Helpers ===
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, retries = 2, delayMs = 1000) {
	for (let i = 0; i <= retries; i++) {
		try {
			return await fn();
		} catch (err) {
			if (i === retries) throw err;
			console.warn(`Retry ${i + 1}/${retries} wegen Fehler: ${err.message}`);
			await delay(delayMs);
		}
	}
}

async function waitForSelectorWithRetry(ctx, selector, options = {}, retries = 4, delayMs = 3000) {
	for (let i = 0; i < retries; i++) {
		try {
			return await ctx.waitForSelector(selector, {
				timeout: 25000,
				...options,
			});
		} catch (err) {
			if (i === retries - 1) throw err;
			console.warn(`Retry Selector "${selector}" wegen: ${err.message}`);
			await delay(delayMs);
		}
	}
}

// ---- XPath helpers (Ersatz für page.waitForXPath / frame.waitForXPath) ----
async function $x(ctx, xpath) {
	const jsHandle = await ctx.evaluateHandle((xp) => {
		const result = [];
		const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
		for (let i = 0; i < snap.snapshotLength; i++) result.push(snap.snapshotItem(i));
		return result;
	}, xpath);
	const props = await jsHandle.getProperties();
	const elements = [];
	for (const p of props.values()) {
		const el = p.asElement();
		if (el) elements.push(el);
	}
	await jsHandle.dispose();
	return elements;
}

async function waitForXPath(ctx, xpath, { visible = false, timeout = 15000 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const els = await $x(ctx, xpath);
		if (els.length) {
			if (!visible) return els[0];
			const box = await els[0].boundingBox();
			if (box) return els[0];
		}
		await delay(100);
	}
	throw new Error(`XPath timeout: ${xpath}`);
}

async function gotoWithRetry(page, url, retries = 5, delayMs = 8000) {
	for (let i = 0; i < retries; i++) {
		try {
			await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
			return;
		} catch (err) {
			if (i === retries - 1) throw err;
			if (/ERR_NETWORK_CHANGED/.test(err.message)) {
				console.warn(`Netzwerk-Problem, warte ${delayMs * 2}ms vor Retry…`);
				await delay(delayMs * 2);
			} else {
				console.warn(`Goto Retry ${i + 1}/${retries} wegen: ${err.message}`);
				await delay(delayMs);
			}
		}
	}
}

// --- CSS.escape Polyfill ---
function cssEscape(value) {
	const string = String(value);
	const length = string.length;
	let index = -1;
	let codeUnit;
	let result = "";
	const firstCodeUnit = string.charCodeAt(0);
	while (++index < length) {
		codeUnit = string.charCodeAt(index);
		if (
			codeUnit == 0x0000 ||
			(codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
			codeUnit == 0x007f ||
			(index == 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
			(index == 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit == 0x002d)
		) {
			result += "\\" + codeUnit.toString(16) + " ";
			continue;
		}
		if (
			codeUnit >= 0x0080 ||
			codeUnit == 0x002d ||
			codeUnit == 0x005f ||
			(codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
			(codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
			(codeUnit >= 0x0061 && codeUnit <= 0x007a)
		) {
			result += string.charAt(index);
			continue;
		}
		result += "\\" + string.charAt(index);
	}
	return result;
}

// Robuster Click im Frame
async function robustClick(frame, handle) {
	const ok = await frame.evaluate((el) => {
		if (!el || el.nodeType !== 1) return false;
		try {
			el.scrollIntoView({
				behavior: "instant",
				block: "center",
				inline: "center",
			});
			el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			el.click();
			return true;
		} catch {
			return false;
		}
	}, handle);
	if (ok) return;
	await handle.click().catch(() => { });
}

/* ===========================
   Wochentags-Logik aus ENV
   =========================== */

// Normalisiert Wochentags-Tokens in Kurzform EN: Mon..Sun
function normalizeWeekToken(tokRaw) {
	if (!tokRaw) return null;
	const t = String(tokRaw).trim().toLowerCase();
	const map = {
		mon: "Mon",
		mo: "Mon",
		tue: "Tue",
		di: "Tue",
		wed: "Wed",
		mi: "Wed",
		thu: "Thu",
		don: "Thu",
		do: "Thu",
		fri: "Fri",
		fr: "Fri",
		sat: "Sat",
		sa: "Sat",
		sun: "Sun",
		so: "Sun",
	};
	// also accept full english
	if (t.startsWith("mon")) return "Mon";
	if (t.startsWith("tue")) return "Tue";
	if (t.startsWith("wed")) return "Wed";
	if (t.startsWith("thu")) return "Thu";
	if (t.startsWith("fri")) return "Fri";
	if (t.startsWith("sat")) return "Sat";
	if (t.startsWith("sun")) return "Sun";
	return map[t] || null;
}

// Parsed Config: returns a map { Mon:"Remote"| "Office", ... }
function buildWeekdayModeMapFromEnv() {
	const map = {};
	const parseMode = (v) =>
		String(v || "")
			.toLowerCase()
			.startsWith("off")
			? "Office"
			: "Remote";

	// 1) WEEKDAY_MODE
	const str = process.env.WEEKDAY_MODE;
	if (str) {
		for (const part of str.split(",")) {
			const [kRaw, vRaw] = part.split(":");
			const key = normalizeWeekToken(kRaw);
			if (!key) continue;
			const mode = parseMode(vRaw);
			map[key] = mode;
		}
	}

	// 2) REMOTE_DAYS / OFFICE_DAYS
	const addDays = (list, mode) => {
		if (!list) return;
		for (const tok of list.split(",")) {
			const key = normalizeWeekToken(tok);
			if (key) map[key] = mode;
		}
	};
	if (process.env.REMOTE_DAYS) addDays(process.env.REMOTE_DAYS, "Remote");
	if (process.env.OFFICE_DAYS) addDays(process.env.OFFICE_DAYS, "Office");

	return map;
}

// dateId: "YYYY-MM-DD" -> weekday "Mon".."Sun" without TZ drift
function weekdayFromDateId(dateId) {
	const [y, m, d] = dateId.split("-").map((n) => parseInt(n, 10));
	// Use UTC to avoid local TZ offset shifting the day
	const dt = new Date(Date.UTC(y, m - 1, d));
	const idx = dt.getUTCDay(); // 0=Sun..6=Sat
	return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][idx];
}

const WEEKDAY_MODE_MAP = buildWeekdayModeMapFromEnv();

function getModeForDate(dateId) {
	const wd = weekdayFromDateId(dateId);
	const envMode = WEEKDAY_MODE_MAP[wd];
	const mode = envMode || DEFAULT_MODE;
	console.log(`🗓️  ${dateId} (${wd}) → Modus: ${mode}${envMode ? " (ENV)" : " (Fallback CLI)"}`);
	return mode;
}

// === MAIN ===
(async () => {
	try {
		const browser = await puppeteer.launch({
			headless: !DEBUG,
			slowMo: SLOWMO, // im Debug z.B. 50ms pro Aktion
			defaultViewport: null,
			dumpio: true,
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
		});
		console.log("Chromium version:", await browser.version());
		if (DEBUG) console.log(`🐢 Debug aktiv – slowMo=${SLOWMO}ms pro Aktion`);

		const page = await browser.newPage();
		browser.on("disconnected", () => console.error("🔌 [browser] disconnected"));

		// === Login (UNVERÄNDERT) ===
		await gotoWithRetry(page, "https://dirs21.rexx-systems.com/login.php");
		await waitForSelectorWithRetry(page, "#loginform_username");
		await page.type("#loginform_username", BENUTZERNAME);
		await waitForSelectorWithRetry(page, "#password");
		await page.type("#password", PASSWORT);
		await waitForSelectorWithRetry(page, "#submit");
		await page.click("#submit");

		// === Navigation „Mein Zeitmanagement“ (UNVERÄNDERT) ===
		await waitForSelectorWithRetry(page, "iframe#Start");
		const startFrameHandle = await page.$("iframe#Start");
		const startFrame = await startFrameHandle.contentFrame();
		await waitForSelectorWithRetry(startFrame, "#menu_666_item", {
			visible: true,
		});
		await Promise.all([
			startFrame.click("#menu_666_item"),
			page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
		]);
		console.log('📁 "Mein Zeitmanagement" geöffnet.');

		// === Widget-Frame erhalten ===
		await waitForSelectorWithRetry(page, "iframe#Unten");
		let untenFrameHandle = await page.$("iframe#Unten");
		let untenFrame = await untenFrameHandle.contentFrame();

		// Alle Ziel-Daten (YYYY-MM-DD) VORAB einsammeln
		const targetDates = await getAllDatesWithSaldo(untenFrame, "-8:00");
		if (targetDates.length === 0) {
			console.log("✅ Keine Tage mit -8:00 gefunden.");
			await browser.close();
			return;
		}
		console.log(`📅 Tage mit -8:00: ${targetDates.join(", ")}`);

		// Pro Datum: einmal öffnen, Zeiten setzen (Start+Ende), Projekt nach Wochentag, speichern
		for (const dateId of targetDates) {
			await waitForSelectorWithRetry(page, "iframe#Unten");
			untenFrameHandle = await page.$("iframe#Unten");
			untenFrame = await untenFrameHandle.contentFrame();

			const modeForThisDay = getModeForDate(dateId); // "Remote" | "Office"

			try {
				await processDayBooking(untenFrame, page, dateId, modeForThisDay);
			} catch (err) {
				console.error(`❌ Fehler beim Buchen für ${dateId}: ${err.message}`);
			}

			await delay(800);
		}

		console.log("✅ Alle Buchungen abgeschlossen.");
		await browser.close();
	} catch (err) {
		console.error("Fatal error:", err);
		process.exit(1);
	}
})();

/* ===========================
   DOM-Hilfsfunktionen (iFrame)
   =========================== */

async function getAllDatesWithSaldo(frame, saldoText) {
	return await frame.evaluate((wantedSaldo) => {
		const out = [];
		document.querySelectorAll("tr.grid_row").forEach((r) => {
			const saldoCell = r.querySelector("td:nth-child(5) div");
			const saldo = saldoCell ? saldoCell.textContent.trim() : "";
			if (saldo === wantedSaldo) {
				const cls = (r.className || "").split(" ").find((c) => c.startsWith("grid_row_pr_"));
				if (cls) out.push(cls.replace("grid_row_pr_", ""));
			}
		});
		return Array.from(new Set(out));
	}, saldoText);
}

/**
 * PRO TAG EINMAL BUCHEN:
 * - klickt den Zeilen-Link "Zeitbuchung erfassen"
 * - setzt Start/Ende im Formular
 * - wählt Projekt (Remote/Office) über globalen Dialog (per Wochentag)
 * - speichert das Formular
 */
async function processDayBooking(untenFrame, page, dateId, modeForDay /*Remote|Office*/) {
	const row = await untenFrame.$(`tr.grid_row.grid_row_pr_${cssEscape(dateId)}`);
	if (!row) throw new Error(`Zeile für ${dateId} nicht gefunden`);

	// Zeilen-Buchungslink robust klicken
	const clicked = await untenFrame.evaluate((r) => {
		const a =
			r.querySelector('a[aria-label="Zeitbuchung erfassen"]') ||
			r.querySelector('a[title*="Zeitbuchung"]') ||
			r.querySelector("a");
		if (!a) return false;
		a.scrollIntoView({ behavior: "instant", block: "center" });
		a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
		a.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		a.click();
		return true;
	}, row);
	if (!clicked) throw new Error("Kein Buchungsbutton in der Zeile gefunden");

	await delay(200);

	// Formular-iFrame im Widget
	const formFrame = await openBookingForm(untenFrame);
	if (!formFrame) throw new Error("Formular nicht geladen");

	// Start- und Endzeit setzen
	await setTimeInForm(formFrame);

	// Projekt wählen (Remote/Office) über globalen Dialog
	const projectClickable = await findProjectClickable(formFrame);
	if (!projectClickable) throw new Error("Projektfeld im Formular nicht gefunden");
	await formFrame.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }), projectClickable);
	await robustClick(formFrame, projectClickable);
	await handleProjektAuswahlDialogOnPage(page, modeForDay);

	// Speichern & schließen
	if (!DEBUG) {
		await saveAndCloseForm(formFrame, untenFrame);
		console.log(`✅ Gebucht @ ${dateId} ${KOMMEN_TIME}–${GEHEN_TIME} (${modeForDay})`);
	} else {
		console.log(`🔍 DEBUG: Buchung @ ${dateId} ${KOMMEN_TIME}–${GEHEN_TIME} (${modeForDay})`);
	}
}

async function openBookingForm(frame) {
	const fh = await frame
		.waitForSelector("iframe#time_workflow_form_layer_iframe", {
			visible: true,
			timeout: 15000,
		})
		.catch(() => null);
	return fh ? await fh.contentFrame() : null;
}

/**
 * Setzt beide Zeitfelder:
 *  - Start: KOMMEN_TIME
 *  - Ende : GEHEN_TIME
 * Nutzt Attribut-Selektoren, weil die IDs mit Ziffer beginnen.
 */
async function setTimeInForm(formFrame) {
	await delay(100);

	const fromCandidates = ['[id="1173_from"]', '[name="1173[from]"]', "#row_ZEIT input.stdformelem_time:first-of-type"];
	const toCandidates = ['[id="1173_to"]', '[name="1173[to]"]', "#row_ZEIT input.stdformelem_time:nth-of-type(2)"];

	let fromInput = null;
	for (const sel of fromCandidates) {
		console.log(`🔭 Versuche fromInput mit Selektor: ${sel}`);
		fromInput = await formFrame.$(sel);
		if (fromInput) {
			console.log(`🎯 fromInput gefunden mit Selektor: ${sel}`);
			break;
		}
	}
	let toInput = null;
	for (const sel of toCandidates) {
		console.log(`🔭 Versuche toInput mit Selektor: ${sel}`);
		toInput = await formFrame.$(sel);
		if (toInput) {
			console.log(`🎯 toInput gefunden mit Selektor: ${sel}`);
			break;
		}
	}

	const fill = async (handle, value) => {
		await formFrame.evaluate((el) => {
			el.focus();
			try {
				el.select?.();
			} catch { }
			el.value = "";
		}, handle);
		await handle.type(value);
		await formFrame.evaluate((el) => {
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			el.blur();
		}, handle);
	};

	if (fromInput && toInput) {
		await fill(fromInput, KOMMEN_TIME);
		await delay(60);
		await fill(toInput, GEHEN_TIME);
		return;
	}

	// Falls UIs abweichen, hier ggf. erweitern:
	if (!fromInput && !toInput) throw new Error("Zeit-Eingabefelder im Formular nicht gefunden");
	if (!fromInput) throw new Error("Start-Eingabefeld im Formular nicht gefunden");
	if (!toInput) throw new Error("End-Eingabefeld im Formular nicht gefunden");
}

async function findProjectClickable(formFrame) {
	const selectors = [
		'a[aria-label*="Projekt"]',
		'button[aria-label*="Projekt"]',
		'a[title*="Projekt"]',
		'button[title*="Projekt"]',
		'a[href*="project"]',
		"button:has(span)",
		"a:has(span)",
	];
	for (const sel of selectors) {
		const h = await formFrame.$(sel).catch(() => null);
		if (!h) continue;
		const txt = await formFrame.evaluate((el) => el.textContent?.trim() || "", h).catch(() => "");
		if (/projekt|projekttätigkeit|project/i.test(txt)) return h;
	}
	const xp = [
		'//a[contains(normalize-space(),"Projekt")]',
		'//button[contains(normalize-space(),"Projekt")]',
		'//a[contains(normalize-space(),"Projekttätigkeit")]',
		'//button[contains(normalize-space(),"Projekttätigkeit")]',
	];
	for (const x of xp) {
		const h = await waitForXPath(formFrame, x, { timeout: 1500 }).catch(() => null);
		if (h) return h;
	}
	return null;
}

async function handleProjektAuswahlDialogOnPage(page, mode /*Office|Remote*/) {
	const layer = await page
		.waitForSelector("#time_pze_selection_layer", {
			visible: true,
			timeout: 15000,
		})
		.catch(() => null);
	if (!layer) throw new Error("Projekt-Auswahl-Dialog wurde nicht angezeigt");

	const label = mode.trim();

	const folderXPath =
		'//div[@id="rexxtree"]' +
		'//span[contains(@class,"dynatree-node") and contains(@class,"dynatree-folder")]' +
		`[.//span[contains(@class,"dynatree-title")]/span[normalize-space()="${label}"] or .//span[contains(@class,"dynatree-title") and normalize-space()="${label}"]]`;
	const folder = await waitForXPath(page, folderXPath, {
		visible: true,
		timeout: 10000,
	}).catch(() => null);
	if (!folder) throw new Error(`Projekt-Knoten "${label}" nicht gefunden.`);

	const expander = await folder.$(".dynatree-expander");
	if (expander) {
		await expander.click().catch(() => { });
		await delay(120);
	}

	const firstLeafXPath =
		folderXPath +
		'/following-sibling::ul//span[contains(@class,"dynatree-node") and not(contains(@class,"dynatree-folder"))][1]';
	const firstLeaf = await waitForXPath(page, firstLeafXPath, {
		visible: true,
		timeout: 10000,
	}).catch(() => null);
	if (!firstLeaf) throw new Error(`Kein Eintrag unter "${label}" gefunden.`);
	const radio = await firstLeaf.$(".dynatree-radio");
	if (radio) await radio.click();
	else await firstLeaf.click();
	await delay(120);

	const applyBtn = await page.$('#aside_navbar_collapse a[aria-label="Übernehmen"]');
	if (applyBtn) {
		await applyBtn.click();
	} else {
		const any = await $x(page, "//a[contains(normalize-space(),'Übernehmen')]");
		if (any[0]) await any[0].click();
	}
	await page
		.waitForSelector("#time_pze_selection_layer", {
			hidden: true,
			timeout: 15000,
		})
		.catch(() => { });
}

async function saveAndCloseForm(formFrame, untenFrame) {
	let btn = await formFrame.$("a#application_creation_toolbar_save");
	if (!btn) {
		const arr = await $x(
			formFrame,
			"//a[contains(normalize-space(),'Beantragen') or contains(normalize-space(),'Speichern')]"
		);
		btn = arr[0];
	}
	if (!btn) throw new Error("Speicher-/Beantragen-Button im Formular fehlt");

	await formFrame.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }), btn);
	await robustClick(formFrame, btn);

	// Warten, bis der Formular-iFrame wieder verschwindet
	await untenFrame
		.waitForSelector("iframe#time_workflow_form_layer_iframe", {
			hidden: true,
			timeout: 30000,
		})
		.catch(async () => {
			await formFrame
				.waitForSelector("a#application_creation_toolbar_save", {
					hidden: true,
					timeout: 10000,
				})
				.catch(() => { });
		});

	// Widget-Container wieder sichtbar (Refresh)
	await retry(
		() =>
			waitForSelectorWithRetry(untenFrame, "div#my_timemanagement_widget", {
				visible: true,
			}),
		2,
		800
	).catch(() => { });
}
