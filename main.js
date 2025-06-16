const puppeteer = require("puppeteer");
const minimist = require("minimist");
require("dotenv").config();

// Kommandozeilenparameter parsen (z. B. --kommen "08:30" --gehen "17:30")
const args = minimist(process.argv.slice(2));
const KOMMEN_TIME = args.kommen || "09:00";
const GEHEN_TIME = args.gehen || "18:00";

const BENUTZERNAME = process.env.BENUTZERNAME;
const PASSWORT = process.env.PASSWORT;

// Hilfsfunktion für Verzögerungen
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-Mechanismus für kritische Schritte
async function retry(fn, retries = 2, delayMs = 1000) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === retries) {
                throw error;
            }
            console.warn(`Retry ${i + 1}/${retries} wegen Fehler: ${error.message}`);
            await delay(delayMs);
        }
    }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new", // Use headless mode for server/CI
    defaultViewport: null,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // Use system Chromium in Docker
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  });
  const page = await browser.newPage();

    // Anmeldung
    await page.goto("https://dirs21.rexx-systems.com/login.php", { waitUntil: "networkidle2" });
    await page.waitForSelector("#loginform_username");
    await page.type("#loginform_username", BENUTZERNAME);
    await page.waitForSelector("#password");
    await page.type("#password", PASSWORT);
    await page.waitForSelector("#submit");
    await page.click("#submit");

    // Navigation im iframe#Start
    await page.waitForSelector("iframe#Start");
    const startFrameHandle = await page.$("iframe#Start");
    const startFrame = await startFrameHandle.contentFrame();
    await startFrame.waitForSelector("#menu_666_item", { visible: true });
    await startFrame.click("#menu_666_item");
    console.log('📁 "Mein Zeitmanagement" geklickt.');

    // Zugriff auf den Zielbereich: iframe#Unten
    await page.waitForSelector("iframe#Unten");
    const untenFrameHandle = await page.$("iframe#Unten");
    const untenFrame = await untenFrameHandle.contentFrame();

    // Warten auf mindestens eine Zeile mit Saldo "-8:00"
    const MAX_WAIT = 15000;
    const INTERVAL = 500;
    let waited = 0;
    let found = false;
    while (waited < MAX_WAIT) {
        await delay(INTERVAL);
        waited += INTERVAL;
        const row = await getRowWithSaldo(untenFrame, "-8:00");
        if (row) {
            found = true;
            break;
        }
    }
    if (!found) {
        console.error("❌ Keine -8:00-Zeilen nach Timeout gefunden.");
        await browser.close();
        return;
    }
    console.log("✅ Mindestens eine Zeile mit Saldo -8:00 gefunden.");

    // Wiederhole den Buchungsvorgang, solange Zeilen mit -8:00 vorhanden sind
    while (true) {
        const row = await getRowWithSaldo(untenFrame, "-8:00");
        if (!row) {
            console.log("Keine weiteren Zeilen mit Saldo -8:00 gefunden.");
            break;
        }
        // Eindeutigen Identifier aus der Zeile extrahieren (angenommen, die Klasse hat das Format "grid_row_pr_YYYY-MM-DD")
        const dateIdentifier = await row.evaluate((r) => {
            const classList = r.className.split(" ");
            const match = classList.find((c) => c.startsWith("grid_row_pr_"));
            return match ? match.replace("grid_row_pr_", "") : null;
        });
        if (!dateIdentifier) {
            console.warn("Kein eindeutiger Identifier in der Zeile gefunden, überspringe.");
            break;
        }

        // 1. "Kommen" buchen
        try {
            await processBooking(row, untenFrame, dateIdentifier, KOMMEN_TIME, "Kommen");
        } catch (error) {
            console.error(`Fehler bei "Kommen"-Buchung für ${dateIdentifier}: ${error.message}`);
            continue;
        }

        // Warten, bis der DOM neu gerendert wurde (z. B. anhand eines bekannten Elements)
        await retry(
            async () => {
                await untenFrame.waitForSelector("div#my_timemanagement_widget", { visible: true, timeout: 10000 });
            },
            2,
            1000
        ).catch(() => {});

        // 2. "Gehen" buchen: Hole die aktualisierte Zeile neu anhand des Identifiers
        const updatedRow = await untenFrame.$(`tr.grid_row_pr_${dateIdentifier}`);
        if (!updatedRow) {
            console.error(`⚠️ Aktualisierte Zeile ${dateIdentifier} nicht gefunden – überspringe "Gehen"-Buchung.`);
            continue;
        }
        try {
            await processBooking(updatedRow, untenFrame, dateIdentifier, GEHEN_TIME, "Gehen");
        } catch (error) {
            console.error(`Fehler bei "Gehen"-Buchung für ${dateIdentifier}: ${error.message}`);
            continue;
        }
        // Optionale Wartezeit zwischen den Einträgen (z. B. 5 Sekunden)
        await delay(5000);
    }

    console.log("✅ Alle Buchungen abgeschlossen.");
    await browser.close();
})();

// Gibt eine Zeile zurück, in der der Saldo genau dem gesuchten Text entspricht
async function getRowWithSaldo(frame, saldoText) {
    const allRows = await frame.$$("tr.grid_row");
    for (const row of allRows) {
        const saldoCell = await row.$("td:nth-child(5) div");
        const text = saldoCell && (await frame.evaluate((el) => el.textContent.trim(), saldoCell));
        if (text === saldoText) {
            return row;
        }
    }
    return null;
}

// Verarbeitet eine Buchung (öffnet Formular, füllt Uhrzeit und klickt "Beantragen")
async function processBooking(row, frame, dateIdentifier, timeValue, label) {
    const buchenLink = await row.$('a[aria-label="Zeitbuchung erfassen"]');
    if (!buchenLink) {
        throw new Error("Kein Buchungsbutton in der Zeile gefunden.");
    }
    await frame.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }), buchenLink);
    await frame.evaluate((el) => el.click(), buchenLink);
    await delay(500);

    const formFrame = await retry(() => openBookingForm(frame), 2, 1000);
    if (!formFrame) {
        throw new Error("Buchungsformular konnte nicht geladen werden.");
    }
    console.log(`🟢 Buche '${label}' um ${timeValue} ...`);
    await bucheZeit(formFrame, timeValue);
    await waitForFormClosure(frame);
}

// Öffnet das Buchungsformular und gibt das zugehörige Content-Frame zurück
async function openBookingForm(frame) {
    const formFrameHandle = await frame
        .waitForSelector("iframe#time_workflow_form_layer_iframe", { visible: true, timeout: 10000 })
        .catch(() => null);
    if (!formFrameHandle) {
        return null;
    }
    return await formFrameHandle.contentFrame();
}

// Wartet darauf, dass das Buchungsformular geschlossen wird
async function waitForFormClosure(frame) {
    await frame
        .waitForSelector("iframe#time_workflow_form_layer_iframe", { hidden: true, timeout: 15000 })
        .catch(() => console.warn("⚠️ Buchungsformular schließt nicht innerhalb des Zeitlimits."));
}

// Füllt im Buchungsformular das Uhrzeitfeld aus und klickt auf "Beantragen"
async function bucheZeit(frame, zeit) {
    await delay(1000);
    let input = null;
    const zeitRow = await frame.$("#row_ZEIT");
    if (zeitRow) {
        input = await zeitRow.$("input.stdformelem_time");
    }
    if (!input) {
        input = await frame.$("#form_1173");
    }
    if (input) {
        await input.click({ clickCount: 3 });
        await input.type(zeit);
    } else {
        throw new Error("Kein Eingabefeld für Uhrzeit gefunden!");
    }

    let button = await frame.$("a#application_creation_toolbar_save");
    if (!button) {
        const btns = await frame.$x("//a[contains(text(), 'Beantragen')]");
        if (btns.length > 0) {
            button = btns[0];
        }
    }
    if (button) {
        await delay(1000);
        await frame.evaluate((el) => el.scrollIntoView(), button);
        await frame.evaluate((el) => el.click(), button);
    } else {
        throw new Error("Kein 'Beantragen'-Button gefunden!");
    }
    await delay(5000);
}
