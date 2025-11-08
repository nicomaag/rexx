// Node.js Puppeteer-Skript zur Buchungsautomatisierung (modular)
// - Login & Navigation unverändert
// - Bucht pro Tag (Saldo -8:00) genau einmal Start/Ende
// - Projektwahl (Remote/Office) nach Wochentag aus ENV (idempotent + robust)
// Debug: --debug [--slowmo=250]; Zeiten: --kommen=09:00 --gehen=18:00
//
// ENV Wochentage (Priorität):
// 1) WEEKDAY_MODE="Mon:Remote,Tue:Office,Wed:Remote,Thu:Office,Fri:Remote"
// 2) REMOTE_DAYS="Mon,Fri" + OFFICE_DAYS="Tue,Wed,Thu"
// 3) Fallback: --mode=Remote|Office

require("dotenv").config();

const minimist = require("minimist");
const { launchBrowser } = require("./lib/browser");
const { gotoWithRetry, waitForSelectorWithRetry, retry, cssEscape, withWatchdog } = require("./lib/utils");
const { doLogin } = require("./lib/login");
const { openMeinZeitmanagement, getUntenFrame, collectDatesWithSaldo, openRowBookingForm } = require("./lib/navigation");
const { waitForTimeInputsStable, setTimeInForm, saveAndCloseForm } = require("./lib/timeform");
const { ensureProjektLayerClosed, openProjektDialogWithStrategies, handleProjektAuswahlDialogOnPage } = require("./lib/projectDialog");
const { getModeForDate, buildWeekdayModeResolver } = require("./lib/weekmode");

// ================= CLI / ENV =================
const args = minimist(process.argv.slice(2));
const KOMMEN_TIME = args.kommen || "09:00";
const GEHEN_TIME = args.gehen || "18:00";
const DEFAULT_MODE = (args.mode || "Office").trim(); // Fallback, falls ENV nichts vorgibt

// Debug & animation delays
const DEBUG = !!args.debug;
const SLOWMO = DEBUG ? parseInt(args.slowmo, 10) || 50 : 0;
const NODE_ANIM_DELAY = parseInt(args.animdelay || process.env.NODE_ANIM_DELAY_MS || 180, 10);
const POST_SELECT_DELAY = 250;

// Credentials (unchanged)
const BENUTZERNAME = process.env.BENUTZERNAME;
const PASSWORT = process.env.PASSWORT;
if (!BENUTZERNAME || !PASSWORT) {
	console.error("❌ BENUTZERNAME oder PASSWORT fehlt!");
	process.exit(1);
}

// Build weekday resolver once (ENV + fallback)
const resolveMode = buildWeekdayModeResolver(DEFAULT_MODE);

// ================== MAIN =====================
(async () => {
	try {
		const { browser, page } = await launchBrowser({ debug: DEBUG, slowMo: SLOWMO });

		await gotoWithRetry(page, "https://dirs21.rexx-systems.com/login.php");
		await doLogin(page, BENUTZERNAME, PASSWORT);

		await openMeinZeitmanagement(page);
		let untenFrame = await getUntenFrame(page);

		const targetDates = await collectDatesWithSaldo(untenFrame, "-8:00");
		if (targetDates.length === 0) {
			console.log("✅ Keine Tage mit -8:00 gefunden.");
			await browser.close();
			return;
		}
		console.log(`📅 Tage mit -8:00: ${targetDates.join(", ")}`);

		for (const dateId of targetDates) {
			// Re-grab frame each iteration (page re-renders)
			untenFrame = await getUntenFrame(page);

			const modeForDay = getModeForDate(dateId, resolveMode);
			try {
				await withWatchdog(
					() => processDayBooking({ untenFrame, page, dateId, modeForDay }),
					DEBUG ? 180000 : 90000,
					`processDayBooking(${dateId})`
				);
			} catch (err) {
				console.error(`❌ Fehler beim Buchen für ${dateId}: ${err.message}`);
			}

			await new Promise(r => setTimeout(r, 800));
		}

		console.log("✅ Alle Buchungen abgeschlossen.");
		await browser.close();
	} catch (err) {
		console.error("Fatal error:", err);
		process.exit(1);
	}
})();

// =============== Per-Day Booking ===============
async function processDayBooking({ untenFrame, page, dateId, modeForDay }) {
	const rowSel = `tr.grid_row.grid_row_pr_${cssEscape(dateId)}`;
	// Click row's "Zeitbuchung erfassen"
	await openRowBookingForm(untenFrame, rowSel);

	// Form iframe
	let formFrame = await waitForm(untenFrame);

	// Fill times with stability + retry (re-render tolerant)
	await retry(async (attempt) => {
		if (attempt > 0) formFrame = await waitForm(untenFrame);
		await waitForTimeInputsStable(formFrame);
		await setTimeInForm(formFrame, { kommen: KOMMEN_TIME, gehen: GEHEN_TIME });
	}, 4, 400, "setTimeInForm");

	// Project selection (robust + idempotent)
	await retry(async (attempt) => {
		if (attempt > 0) {
			await ensureProjektLayerClosed(page);
			formFrame = await waitForm(untenFrame);
		}
		await ensureProjektLayerClosed(page);
		await openProjektDialogWithStrategies(formFrame, page);
		await handleProjektAuswahlOnPage(page, modeForDay);
	}, 4, 700, "openSelectProject");

	// Save
	if (!DEBUG) {
		await saveAndCloseForm(formFrame, untenFrame);
		console.log(`✅ Gebucht @ ${dateId} ${KOMMEN_TIME}–${GEHEN_TIME} (${modeForDay})`);
	} else {
		console.log(`🔍 DEBUG: Buchung @ ${dateId} ${KOMMEN_TIME}–${GEHEN_TIME} (${modeForDay})`);
	}

	// ---- inner wrappers to pass constants cleanly ----
	async function waitForm(frame) {
		const fh = await frame
			.waitForSelector("iframe#time_workflow_form_layer_iframe", { visible: true, timeout: 15000 })
			.catch(() => null);
		return fh ? await fh.contentFrame() : null;
	}

	async function handleProjektAuswahlOnPage(page, mode) {
		await handleProjektAuswahlDialogOnPage(page, mode, {
			nodeAnimDelay: NODE_ANIM_DELAY,
			postSelectDelay: POST_SELECT_DELAY
		});
	}
}
