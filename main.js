// Node.js Puppeteer-Skript zur Buchungsautomatisierung mit verbessertem Frame-Handling und Fehler-Skipping
const puppeteer = require("puppeteer");
const minimist = require("minimist");
require("dotenv").config();

// Kommandozeilenparameter parsen
const args = minimist(process.argv.slice(2));
const KOMMEN_TIME = args.kommen || "09:00";
const GEHEN_TIME = args.gehen || "18:00";

const BENUTZERNAME = process.env.BENUTZERNAME;
const PASSWORT = process.env.PASSWORT;

// Verzögerung
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-Mechanismus
async function retry(fn, retries = 2, delayMs = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries) throw error;
      console.warn(`Retry ${i + 1}/${retries} wegen Fehler: ${error.message}`);
      await delay(delayMs);
    }
  }
}

// Check Umgebungsvariablen
if (!BENUTZERNAME || !PASSWORT) {
  console.error("❌ BENUTZERNAME oder PASSWORT fehlt!");
  process.exit(1);
}

// Robustes WaitForSelector
async function waitForSelectorWithRetry(
  ctx,
  selector,
  options = {},
  retries = 4,
  delayMs = 3000
) {
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

// Navigation mit Retry (Network-Fehler speziell)
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

// Hauptroutine
(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: false, // OK
      defaultViewport: null, // OK
      dumpio: true, // Pipe Chromium logs to stdout
      // Prefer the **bundled** Chromium first to avoid protocol mismatch:
      // Remove executablePath unless you must use system Chrome.
      // executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    console.log("Chromium version:", await browser.version());
    const page = await browser.newPage();

    page.on("console", (msg) => {
      // Log browser console (levels + args)
      const args = msg
        .args()
        .map((a) => a.toString())
        .join(" | ");
      console.log(
        `🧭 [console:${msg.type()}] ${msg.text()} ${args ? " :: " + args : ""}`
      );
    });
    page.on("pageerror", (err) => console.error("💥 [pageerror]", err));
    page.on("error", (err) => console.error("💥 [error]", err));
    page.on("requestfailed", (req) => {
      console.warn("⚠️ [requestfailed]", req.url(), req.failure()?.errorText);
    });
    page.on("framedetached", (f) =>
      console.warn("🧩 [framedetached]", f.url())
    );
    page.on("framenavigated", (f) =>
      console.log("➡️ [framenavigated]", f.url())
    );
    page.on("dialog", (d) => d.dismiss().catch(() => {})); // avoid modal blocks

    browser.on("disconnected", () =>
      console.error("🔌 [browser] disconnected")
    );

    // Anmeldung
    await gotoWithRetry(page, "https://dirs21.rexx-systems.com/login.php");
    await waitForSelectorWithRetry(page, "#loginform_username");
    await page.type("#loginform_username", BENUTZERNAME);
    await waitForSelectorWithRetry(page, "#password");
    await page.type("#password", PASSWORT);
    await waitForSelectorWithRetry(page, "#submit");
    await page.click("#submit");

    // Navigation in "Mein Zeitmanagement"
    await waitForSelectorWithRetry(page, "iframe#Start");
    const startFrameHandle = await page.$("iframe#Start");
    const startFrame = await startFrameHandle.contentFrame();
    await waitForSelectorWithRetry(startFrame, "#menu_666_item", {
      visible: true,
    });
    // Klick löst Navigation aus, daher kombinieren
    await Promise.all([
      startFrame.click("#menu_666_item"),
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
    ]);
    console.log('📁 "Mein Zeitmanagement" geöffnet.');

    // Booking-Loop mit Skip-Logik
    const failCounts = {};
    while (true) {
      // Frame immer neu holen
      await waitForSelectorWithRetry(page, "iframe#Unten");
      const untenFrameHandle = await page.$("iframe#Unten");
      const untenFrame = await untenFrameHandle.contentFrame();

      // Zeile mit -8:00 suchen
      const row = await getRowWithSaldo(untenFrame, "-8:00");
      if (!row) {
        console.log("Keine weiteren -8:00-Zeilen.");
        break;
      }

      // Datum extrahieren
      const dateIdentifier = await row.evaluate((r) => {
        const cls = r.className
          .split(" ")
          .find((c) => c.startsWith("grid_row_pr_"));
        return cls?.replace("grid_row_pr_", "");
      });
      if (!dateIdentifier) break;

      // Skip nach 2 Fehlversuchen
      if ((failCounts[dateIdentifier] || 0) >= 2) {
        console.warn(
          `Überspringe ${dateIdentifier} nach ${failCounts[dateIdentifier]} Fehlversuchen.`
        );
        await row.evaluate((r) => (r.style.display = "none"));
        continue;
      }

      // 1) Kommen buchen
      try {
        await processBooking(
          row,
          untenFrame,
          dateIdentifier,
          KOMMEN_TIME,
          "Kommen"
        );
      } catch (err) {
        failCounts[dateIdentifier] = (failCounts[dateIdentifier] || 0) + 1;
        console.error(`Fehler bei 'Kommen' ${dateIdentifier}: ${err.message}`);
        continue;
      }

      // Kurz warten auf Neuladen
      await retry(
        () =>
          waitForSelectorWithRetry(untenFrame, "div#my_timemanagement_widget", {
            visible: true,
          }),
        2,
        1000
      ).catch(() => {});

      // 2) Gehen buchen
      const updatedRow = await untenFrame.$(`tr.grid_row_pr_${dateIdentifier}`);
      if (!updatedRow) {
        console.error(
          `Zeile ${dateIdentifier} nicht gefunden, überspringe 'Gehen'.`
        );
        failCounts[dateIdentifier] = (failCounts[dateIdentifier] || 0) + 1;
        continue;
      }
      try {
        await processBooking(
          updatedRow,
          untenFrame,
          dateIdentifier,
          GEHEN_TIME,
          "Gehen"
        );
      } catch (err) {
        failCounts[dateIdentifier] = (failCounts[dateIdentifier] || 0) + 1;
        console.error(`Fehler bei 'Gehen' ${dateIdentifier}: ${err.message}`);
        continue;
      }

      // Erfolgreich → Fehlzähler resetten und Pause
      delete failCounts[dateIdentifier];
      await delay(5000);
    }

    console.log("✅ Alle Buchungen abgeschlossen.");
    await browser.close();
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  }
})();

// Hilfsfunktionen
async function getRowWithSaldo(frame, saldoText) {
  const rows = await frame.$$("tr.grid_row");
  for (const r of rows) {
    const cell = await r.$("td:nth-child(5) div");
    const txt =
      cell && (await frame.evaluate((el) => el.textContent.trim(), cell));
    if (txt === saldoText) return r;
  }
  return null;
}

async function processBooking(row, frame, dateId, timeValue, label) {
  const buchenLink = await row.$('a[aria-label="Zeitbuchung erfassen"]');
  if (!buchenLink) throw new Error("Kein Buchungsbutton gefunden");
  await frame.evaluate(
    (el) => el.scrollIntoView({ behavior: "smooth", block: "center" }),
    buchenLink
  );
  await frame.evaluate((el) => el.click(), buchenLink);
  await delay(500);

  const formFrame = await retry(() => openBookingForm(frame), 2, 1000);
  if (!formFrame) throw new Error("Formular nicht geladen");
  console.log(`🟢 Buche '${label}' um ${timeValue}`);
  await bucheZeit(formFrame, timeValue);
  await waitForFormClosure(frame);
}

async function openBookingForm(frame) {
  const fh = await frame
    .waitForSelector("iframe#time_workflow_form_layer_iframe", {
      visible: true,
      timeout: 10000,
    })
    .catch(() => null);
  return fh ? await fh.contentFrame() : null;
}

async function waitForFormClosure(frame) {
  try {
    await frame.waitForSelector("iframe#time_workflow_form_layer_iframe", {
      hidden: true,
      timeout: 30000,
    });
  } catch {
    console.warn("⚠️ Formular schließt nicht, warte auf Button-Verschwinden");
    await frame
      .waitForSelector("a#application_creation_toolbar_save", {
        hidden: true,
        timeout: 10000,
      })
      .catch(() => {});
  }
}

async function bucheZeit(frame, zeit) {
  await delay(1000);
  let input =
    (await frame.$("#row_ZEIT input.stdformelem_time")) ||
    (await frame.$("#form_1173"));
  if (!input) throw new Error("Zeitfeld nicht gefunden");
  await input.click({ clickCount: 3 });
  await input.type(zeit);

  let btn = await frame.$("a#application_creation_toolbar_save");
  if (!btn) {
    const arr = await frame.$x("//a[contains(text(),'Beantragen')]");
    btn = arr[0];
  }
  if (!btn) throw new Error("Beantragen-Button fehlt");
  await frame.evaluate((el) => el.scrollIntoView(), btn);
  await frame.evaluate((el) => el.click(), btn);
  await delay(5000);
}
