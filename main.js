// Node.js Puppeteer-Skript zur Buchungsautomatisierung (LOGIN & NAVIGATION UNVERÄNDERT)
// Bucht JEDE Zeile mit Saldo -8:00 direkt in der Buchungsliste – PRO TAG NUR EIN MAL:
//   - öffnet Formular aus der jeweiligen Tabellenzeile
//   - setzt Start- (Kommen) und Endzeit (Gehen) mit stabilen Waits/Retry
//   - öffnet robust den globalen Projekt-Dialog (idempotent) & wählt Remote/Office (pro Wochentag aus ENV)
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

// Debug-Schalter
const DEBUG = !!args.debug;
const SLOWMO = DEBUG ? parseInt(args.slowmo, 10) || 50 : 0;

// Zusätzliche Miniverzögerungen für UI-Animationen
const NODE_ANIM_DELAY = parseInt(args.animdelay || process.env.NODE_ANIM_DELAY_MS || 180, 10);
const POST_SELECT_DELAY = 250;

// === ENV-Creds (UNVERÄNDERT) ===
const BENUTZERNAME = process.env.BENUTZERNAME;
const PASSWORT = process.env.PASSWORT;

if (!BENUTZERNAME || !PASSWORT) {
	console.error("❌ BENUTZERNAME oder PASSWORT fehlt!");
	process.exit(1);
}

// === Helpers ===
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, retries = 3, delayMs = 600, tag = "op") {
	let lastErr;
	for (let i = 0; i < retries; i++) {
		try { return await fn(i); }
		catch (err) {
			lastErr = err;
			console.warn(`↻ Retry ${i + 1}/${retries} (${tag}): ${err.message}`);
			await delay(delayMs);
		}
	}
	throw lastErr;
}

async function waitForSelectorWithRetry(ctx, selector, options = {}, retries = 4, delayMs = 3000) {
	for (let i = 0; i < retries; i++) {
		try {
			return await ctx.waitForSelector(selector, { timeout: 25000, ...options });
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
			el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
			el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
			el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			el.click();
			return true;
		} catch { return false; }
	}, handle);
	if (ok) return;
	await handle.click().catch(() => { });
}

/* ===========================
   Wochentags-Logik aus ENV
   =========================== */

function normalizeWeekToken(tokRaw) {
	if (!tokRaw) return null;
	const t = String(tokRaw).trim().toLowerCase();
	const map = {
		mon: "Mon", mo: "Mon",
		tue: "Tue", di: "Tue",
		wed: "Wed", mi: "Wed",
		thu: "Thu", don: "Thu", do: "Thu",
		fri: "Fri", fr: "Fri",
		sat: "Sat", sa: "Sat",
		sun: "Sun", so: "Sun",
	};
	if (t.startsWith("mon")) return "Mon";
	if (t.startsWith("tue")) return "Tue";
	if (t.startsWith("wed")) return "Wed";
	if (t.startsWith("thu")) return "Thu";
	if (t.startsWith("fri")) return "Fri";
	if (t.startsWith("sat")) return "Sat";
	if (t.startsWith("sun")) return "Sun";
	return map[t] || null;
}

function buildWeekdayModeMapFromEnv() {
	const map = {};
	const parseMode = (v) => (String(v || "").toLowerCase().startsWith("off") ? "Office" : "Remote");

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

function weekdayFromDateId(dateId) {
	const [y, m, d] = dateId.split("-").map((n) => parseInt(n, 10));
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

/* ===========================
   Watchdog (pro Tag)
   =========================== */

async function withWatchdog(promiseFactory, ms, label) {
	let timeout;
	const timeoutPromise = new Promise((_, rej) => {
		timeout = setTimeout(() => rej(new Error(`Watchdog timeout (${label}) after ${ms}ms`)), ms);
	});
	try {
		const res = await Promise.race([promiseFactory(), timeoutPromise]);
		return res;
	} finally {
		clearTimeout(timeout);
	}
}

// === MAIN ===
(async () => {
	try {
		const browser = await puppeteer.launch({
			headless: false,
			slowMo: 0,
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
		await waitForSelectorWithRetry(startFrame, "#menu_666_item", { visible: true });
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
				await withWatchdog(
					() => processDayBooking(untenFrame, page, dateId, modeForThisDay),
					DEBUG ? 180000 : 90000,
					`processDayBooking(${dateId})`
				);
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
 * - wartet stabil, setzt Start/Ende (mit Retry)
 * - öffnet robust den globalen Projekt-Dialog (idempotent) & wählt Modus
 * - speichert das Formular (blockierend, bis Layer geschlossen)
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

	await delay(150);

	// Formular-iFrame im Widget
	let formFrame = await openBookingForm(untenFrame);
	if (!formFrame) throw new Error("Formular nicht geladen");

	// Start- und Endzeit mit Retry setzen (Form re-render tolerant)
	await retry(async (attempt) => {
		if (attempt > 0) {
			formFrame = await openBookingForm(untenFrame);
			if (!formFrame) throw new Error("Formular nicht geladen (nach Re-Render)");
		}
		await waitForTimeInputsStable(formFrame);
		await setTimeInForm(formFrame);
	}, 4, 400, "setTimeInForm");

	// Projekt wählen (Remote/Office) – idempotent & robust
	await retry(async (attempt) => {
		if (attempt > 0) {
			await ensureProjektLayerClosed(page);
			formFrame = await openBookingForm(untenFrame);
			if (!formFrame) throw new Error("Formular nicht geladen (vor Projektwahl)");
		}
		await ensureProjektLayerClosed(page);
		await openProjektDialogWithStrategies(formFrame, page);      // öffnet zuverlässig den Layer oder re-used offenen
		await handleProjektAuswahlDialogOnPage(page, modeForDay);    // wählt Eintrag & „Übernehmen“ (wartet bis Layer wieder zu)
	}, 4, 700, "openSelectProject");

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
		.waitForSelector("iframe#time_workflow_form_layer_iframe", { visible: true, timeout: 15000 })
		.catch(() => null);
	return fh ? await fh.contentFrame() : null;
}

/**
 * Wartet bis die Zeitsektion stabil ist (mind. 2 Zeit-Inputs vorhanden).
 */
async function waitForTimeInputsStable(formFrame) {
	await formFrame.waitForFunction(() => {
		const box = document.querySelector('#row_ZEIT');
		if (!box) return false;
		const inputs = box.querySelectorAll('input.stdformelem_time');
		return inputs && inputs.length >= 2;
	}, { timeout: 8000 });
}

/**
 * Setzt beide Zeitfelder (Start/Ende) und feuert die benötigten Events.
 */
async function setTimeInForm(formFrame) {
	const fromCandidates = ['[id="1173_from"]', '[name="1173[from]"]', '#row_ZEIT input.stdformelem_time:first-of-type'];
	const toCandidates = ['[id="1173_to"]', '[name="1173[to]"]', '#row_ZEIT input.stdformelem_time:nth-of-type(2)'];

	await delay(50);

	let fromInput = null;
	for (const sel of fromCandidates) {
		console.log(`🔭 Versuche fromInput mit Selektor: ${sel}`);
		fromInput = await formFrame.$(sel);
		if (fromInput) { console.log(`🎯 fromInput gefunden mit Selektor: ${sel}`); break; }
	}
	let toInput = null;
	for (const sel of toCandidates) {
		console.log(`🔭 Versuche toInput mit Selektor: ${sel}`);
		toInput = await formFrame.$(sel);
		if (toInput) { console.log(`🎯 toInput gefunden mit Selektor: ${sel}`); break; }
	}

	if (!fromInput || !toInput) {
		const both = await formFrame.$$('#row_ZEIT input.stdformelem_time');
		if (both.length >= 2) {
			fromInput = fromInput || both[0];
			toInput = toInput || both[1];
			console.log("🛟 Fallback: #row_ZEIT input.stdformelem_time [0] & [1] verwendet");
		}
	}

	const fill = async (handle, value) => {
		await formFrame.evaluate((el, v) => {
			el.focus();
			try { el.select?.(); } catch { }
			el.value = "";
			el.value = v;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			el.blur();
		}, handle, value);
	};

	if (fromInput && toInput) {
		await fill(fromInput, KOMMEN_TIME);
		await delay(80);
		await fill(toInput, GEHEN_TIME);
		return;
	}

	if (!fromInput && !toInput) throw new Error("Zeit-Eingabefelder im Formular nicht gefunden");
	if (!fromInput) throw new Error("Start-Eingabefeld im Formular nicht gefunden");
	if (!toInput) throw new Error("End-Eingabefeld im Formular nicht gefunden");
}

/* ===========================
   Projekt-Dialog: Robust & Idempotent
   =========================== */

async function ensureProjektLayerClosed(page) {
	const open = await page.$('#time_pze_selection_layer');
	if (open) {
		const visible = await page.evaluate(el => {
			const s = window.getComputedStyle(el);
			return s && s.display !== 'none' && s.visibility !== 'hidden';
		}, open).catch(() => false);
		if (visible) {
			const btn = await $x(page, "//a[contains(normalize-space(),'Abbrechen') or contains(normalize-space(),'Schließen')]");
			if (btn[0]) await btn[0].click().catch(() => { });
			await page.keyboard.press('Escape').catch(() => { });
			await page.waitForSelector('#time_pze_selection_layer', { hidden: true, timeout: 3000 }).catch(() => { });
		}
	}
}

/**
 * Öffnet den Projekt-Layer, falls nicht bereits offen (idempotent).
 */
async function openProjektDialogWithStrategies(formFrame, page) {
	// Bereits offen?
	const already = await page.$('#time_pze_selection_layer');
	if (already) {
		const visible = await page.evaluate(el => {
			const s = window.getComputedStyle(el);
			return s && s.display !== 'none' && s.visibility !== 'hidden';
		}, already).catch(() => false);
		if (visible) return; // Layer schon offen
	}

	const candidateSelectors = [
		'a[aria-label*="Projekt"]',
		'button[aria-label*="Projekt"]',
		'a[title*="Projekt"]',
		'button[title*="Projekt"]',
		'a[href*="project"]',
		'button:has(span)',
		'a:has(span)',
		'#row_ZEIT ~ * a[aria-label*="Projekt"]',
		'#row_ZEIT ~ * button[aria-label*="Projekt"]',
	];

	// 1) Klassische Buttons
	for (const sel of candidateSelectors) {
		const h = await formFrame.$(sel).catch(() => null);
		if (!h) continue;
		const txt = await formFrame.evaluate((el) => (el.textContent || el.getAttribute('aria-label') || '').trim(), h).catch(() => "");
		if (!/projekt|projekttätigkeit|project/i.test(txt)) continue;

		await formFrame.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }), h);
		await robustClick(formFrame, h);
		const ok = await page.waitForSelector('#time_pze_selection_layer', { visible: true, timeout: 2000 }).then(() => true).catch(() => false);
		if (ok) return;
	}

	// 2) Textbasierte Suche im Formular
	const textHandle = await formFrame.evaluateHandle(() => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
		while (walker.nextNode()) {
			const el = walker.currentNode;
			const txt = (el.textContent || '').trim();
			if (txt && /projekt|projekttätigkeit/i.test(txt)) return el;
		}
		return null;
	}).catch(() => null);
	if (textHandle && textHandle.asElement()) {
		const el = textHandle.asElement();
		await formFrame.evaluate((e) => e.scrollIntoView({ behavior: "instant", block: "center" }), el);
		await robustClick(formFrame, el);
		const ok = await page.waitForSelector('#time_pze_selection_layer', { visible: true, timeout: 2000 }).then(() => true).catch(() => false);
		if (ok) return;
	}

	// 3) Fokussierbares Feld mit Label „Projekt“ → Enter/Space via page.keyboard
	const labelField = await findFieldByLabelText(formFrame, /projekt|projekttätigkeit/i);
	if (labelField) {
		await formFrame.evaluate((e) => e.scrollIntoView({ behavior: "instant", block: "center" }), labelField);
		await labelField.focus().catch(() => { });
		await page.keyboard.press('Enter').catch(() => { });
		let ok = await page.waitForSelector('#time_pze_selection_layer', { visible: true, timeout: 1500 }).then(() => true).catch(() => false);
		if (ok) return;

		await page.keyboard.press('Space').catch(() => { });
		ok = await page.waitForSelector('#time_pze_selection_layer', { visible: true, timeout: 1500 }).then(() => true).catch(() => false);
		if (ok) return;
	}

	// 4) Doppelklick auf mögliche Trigger
	for (const sel of candidateSelectors) {
		const h = await formFrame.$(sel).catch(() => null);
		if (!h) continue;
		await formFrame.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }), h);
		await h.click({ clickCount: 2 }).catch(() => { });
		const ok = await page.waitForSelector('#time_pze_selection_layer', { visible: true, timeout: 1500 }).then(() => true).catch(() => false);
		if (ok) return;
	}

	throw new Error("Projektfeld im Formular nicht gefunden/öffnen fehlgeschlagen");
}

// findet ein Eingabefeld, das zu einer Label-/Text-Zelle mit Regex passt
async function findFieldByLabelText(formFrame, regex) {
	const handles = await formFrame.$$('label, .stdformlabel, th, td, span, a, button');
	for (const h of handles) {
		const txt = await formFrame.evaluate(el => (el.textContent || '').trim(), h).catch(() => "");
		if (!txt || !regex.test(txt)) continue;
		const neighbor = await formFrame.evaluateHandle((el) => {
			const root = el.closest('tr, .row, .cf_row, .stdformrow') || el.parentElement;
			if (!root) return null;
			const inp = root.querySelector('input, a[role="button"], button, a');
			return inp || null;
		}, h).catch(() => null);
		if (neighbor && neighbor.asElement()) return neighbor.asElement();
	}
	return null;
}

/* ===========================
   Projekt-Dialog: Auswahl & Übernehmen (idempotent + state check)
   =========================== */

const MODE_ALIASES = {
	Remote: ["Remote", "Homeoffice", "Home Office", "Home-Office", "Mobiles Arbeiten", "Mobile Arbeit"],
	Office: ["Office", "Büro", "Office Stuttgart", "Office Nürnberg", "Vor Ort", "Onsite"],
};

function normalizeText(s) {
	return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function getSelectedLeafText(page) {
	// tries to read the title text of the selected node (or checked radio) if any
	return await page.evaluate(() => {
		const node = document.querySelector('#rexxtree .dynatree-node.dynatree-selected') ||
			document.querySelector('#rexxtree .dynatree-radio input:checked')?.closest('.dynatree-node');
		if (!node) return "";
		const title = node.querySelector('.dynatree-title');
		if (!title) return (node.textContent || "").trim();
		return title.textContent.trim();
	}).catch(() => "");
}

async function leafMatchesAnyLabel(page, leafHandle, labels) {
	const text = await page.evaluate(el => {
		const t = el.querySelector('.dynatree-title');
		return (t ? t.textContent : el.textContent) || "";
	}, leafHandle).catch(() => "");
	const norm = normalizeText(text);
	return labels.some(lbl => norm.includes(normalizeText(lbl)));
}

async function isLeafSelected(page, leafHandle) {
	return await page.evaluate(el => {
		const node = el.closest('.dynatree-node') || el;
		if (node.classList.contains('dynatree-selected')) return true;
		const radio = node.querySelector('.dynatree-radio input, input[type=radio]');
		return !!(radio && radio.checked);
	}, leafHandle).catch(() => false);
}

async function handleProjektAuswahlDialogOnPage(page, mode /*Office|Remote*/) {
	const layer = await page
		.waitForSelector("#time_pze_selection_layer", { visible: true, timeout: 15000 })
		.catch(() => null);
	if (!layer) throw new Error("Projekt-Auswahl-Dialog wurde nicht angezeigt");

	const labels = MODE_ALIASES[mode] || [mode];

	// (A) Prüfe, ob bereits eine passende Auswahl existiert → direkt übernehmen
	const currentText = await getSelectedLeafText(page);
	if (currentText) {
		const match = labels.some(lbl => normalizeText(currentText).includes(normalizeText(lbl)));
		if (match) {
			// kleine Wartezeit, falls noch Animationsreste laufen
			await delay(POST_SELECT_DELAY);
			await clickApplyAndWaitClose(page);
			return;
		}
	}

	// (B) Andernfalls: suche passenden Folder/Leaf und wähle exakt einen passenden Leaf
	let targetLeaf = await findAnyLeafMatchingMode(page, labels);
	if (!targetLeaf) {
		// Versuche über Folder → first leaf
		let folder = null;
		let folderXPath = null;
		for (const label of labels) {
			const xp =
				'//div[@id="rexxtree"]' +
				'//span[contains(@class,"dynatree-node") and contains(@class,"dynatree-folder")]' +
				`[.//span[contains(@class,"dynatree-title")]/span[normalize-space()="${label}"] or .//span[contains(@class,"dynatree-title") and normalize-space()="${label}"]]`;
			const f = await waitForXPath(page, xp, { visible: true, timeout: 2000 }).catch(() => null);
			if (f) { folder = f; folderXPath = xp; break; }
		}
		if (folder) {
			await expandFolderEnsureChildren(page, folder, folderXPath);
			// nach expand: suche irgendeinen passenden Leaf unterhalb
			targetLeaf = await findAnyLeafMatchingMode(page, labels);
		}
	}

	if (!targetLeaf) throw new Error(`Kein Eintrag zu "${mode}" gefunden.`);

	// (C) Wähle Leaf nur, wenn noch nicht ausgewählt
	const alreadySelected = await isLeafSelected(page, targetLeaf);
	if (!alreadySelected) {
		await selectLeaf(page, targetLeaf); // Titel → Delay → Radio (falls nötig) → Wait selected
	}

	// (D) Finaler State-Check (muss zu Mode passen) vor Apply
	const selectedText = await getSelectedLeafText(page);
	const ok = labels.some(lbl => normalizeText(selectedText).includes(normalizeText(lbl)));
	if (!ok) {
		throw new Error(`Zielauswahl passt nicht: erwartet ${labels.join(" / ")}, gefunden: "${selectedText || "-"}"`);
	}

	await clickApplyAndWaitClose(page);
}

async function expandFolderEnsureChildren(page, folder, folderXPath) {
	const expander = await folder.$(".dynatree-expander");
	if (expander) { await expander.click().catch(() => { }); await delay(140); }

	let childrenVisible = await waitForXPath(
		page,
		folderXPath + '/following-sibling::ul',
		{ visible: true, timeout: 1500 }
	).then(() => true).catch(() => false);
	if (childrenVisible) return;

	const title = await folder.$('.dynatree-title');
	if (title) { await title.click().catch(() => { }); await delay(140); }

	childrenVisible = await waitForXPath(
		page,
		folderXPath + '/following-sibling::ul',
		{ visible: true, timeout: 1500 }
	).then(() => true).catch(() => false);
	if (childrenVisible) return;

	if (expander) { await expander.click({ clickCount: 2 }).catch(() => { }); await delay(150); }
	if (title) { await title.click({ clickCount: 2 }).catch(() => { }); await delay(150); }

	await waitForXPath(page, folderXPath + '/following-sibling::ul', { visible: true, timeout: 800 }).catch(() => { });
}

async function findAnyLeafMatchingMode(page, labels) {
	for (const label of labels) {
		const xp =
			'//div[@id="rexxtree"]' +
			`//span[contains(@class,"dynatree-title") and (contains(normalize-space(),"${label}") or normalize-space()="${label}")]` +
			'/ancestor::span[contains(@class,"dynatree-node") and not(contains(@class,"dynatree-folder"))][1]';
		const h = await waitForXPath(page, xp, { visible: true, timeout: 800 }).catch(() => null);
		if (h) return h;
	}
	return null;
}

/**
 * Auswahl mit Zustandsprüfung:
 * - Titel-Klick → Delay (Animation)
 * - Wenn Radio vorhanden und nicht checked → Radio-Klick
 * - Warten bis selected/checked → kleiner Post-Delay
 * - Nie doppelt klicken, wenn bereits selected
 */
async function selectLeaf(page, leafHandle) {
	// ist Leaf bereits gewählt?
	if (await isLeafSelected(page, leafHandle)) {
		await delay(POST_SELECT_DELAY);
		return;
	}

	const title = await leafHandle.$('.dynatree-title');
	if (title) {
		await title.click().catch(() => { });
		await delay(NODE_ANIM_DELAY);
	} else {
		await leafHandle.click().catch(() => { });
		await delay(NODE_ANIM_DELAY);
	}

	// radio ggf. klicken (nur wenn nicht bereits checked)
	const radio = await leafHandle.$(".dynatree-radio input, input[type=radio]");
	if (radio) {
		const already = await page.evaluate(inp => !!inp.checked, radio).catch(() => false);
		if (!already) await radio.click().catch(() => { });
	}

	// Warten, bis ausgewählt (Klasse oder Radio-Checked)
	await page.waitForFunction((el) => {
		const node = el.closest('.dynatree-node') || el;
		if (node.classList.contains('dynatree-selected')) return true;
		const r = node.querySelector('.dynatree-radio input, input[type=radio]');
		return !!(r && r.checked);
	}, { timeout: 3000 }, leafHandle).catch(() => { });

	await delay(POST_SELECT_DELAY);
}

/**
 * Klickt „Übernehmen“ und wartet, bis der Layer verschwunden ist.
 * Falls Warnung erscheint („Bitte wählen Sie eine Projektkategorie aus.“),
 * klickt automatisch „OK“, wartet kurz und versucht die Übernahme erneut (2 Versuche).
 * Vor dem Klicken prüft sie, dass überhaupt eine Auswahl vorhanden ist.
 */
async function clickApplyAndWaitClose(page) {
	// Hard check: eine Auswahl muss vorhanden sein
	const hasSelection = await page.evaluate(() => {
		const selNode = document.querySelector('#rexxtree .dynatree-node.dynatree-selected');
		const selRadio = document.querySelector('#rexxtree .dynatree-radio input:checked');
		return !!(selNode || selRadio);
	}).catch(() => false);

	if (!hasSelection) throw new Error("Übernehmen ohne Auswahl verhindert (keine Projektkategorie gewählt)");

	for (let attempt = 0; attempt < 2; attempt++) {
		await delay(150);

		const applyBtn = await page.$('#aside_navbar_collapse a[aria-label="Übernehmen"]');
		if (applyBtn) {
			await applyBtn.click().catch(() => { });
		} else {
			const any = await $x(page, "//a[contains(normalize-space(),'Übernehmen')]");
			if (any[0]) await any[0].click().catch(() => { });
		}

		const closed = await page
			.waitForSelector("#time_pze_selection_layer", { hidden: true, timeout: 1000 })
			.then(() => true)
			.catch(() => false);

		if (closed) return;

		// Prüfe Alert
		const alertBox = await page.$('#confirmBoxOuter');
		const alertVisible = alertBox
			? await page.evaluate(el => {
				const s = window.getComputedStyle(el);
				return s && s.display !== 'none' && s.visibility !== 'hidden';
			}, alertBox).catch(() => false)
			: false;

		if (alertVisible) {
			const okBtn =
				(await page.$('#confirmButtons .btn.primary[name="ok"]')) ||
				(await page.$('#confirmButtons .btn.primary'));
			if (okBtn) await okBtn.click().catch(() => { });
			await page.waitForSelector('#confirmBoxOuter', { hidden: true, timeout: 2000 }).catch(() => { });
			await delay(250);
			continue; // nochmal versuchen
		}

		const closedLate = await page
			.waitForSelector("#time_pze_selection_layer", { hidden: true, timeout: 3000 })
			.then(() => true)
			.catch(() => false);
		if (closedLate) return;
	}

	await page
		.waitForSelector("#time_pze_selection_layer", { hidden: true, timeout: 6000 })
		.catch(() => { throw new Error("Projekt-Dialog schloss nicht rechtzeitig (nach Alert-Handling)"); });
}

/* ===========================
   Speichern & Abschluss
   =========================== */

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
		.waitForSelector("iframe#time_workflow_form_layer_iframe", { hidden: true, timeout: 30000 })
		.catch(async () => {
			await formFrame.waitForSelector("a#application_creation_toolbar_save", { hidden: true, timeout: 10000 }).catch(() => { });
		});

	// Widget-Container wieder sichtbar (Refresh)
	await retry(
		() => waitForSelectorWithRetry(untenFrame, "div#my_timemanagement_widget", { visible: true }),
		2,
		800,
		"widgetRefresh"
	).catch(() => { });
}
