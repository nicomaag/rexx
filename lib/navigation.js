const { waitForSelectorWithRetry, retry } = require("./utils");

// open left menu -> Mein Zeitmanagement (unchanged)
async function openMeinZeitmanagement(page) {
    await waitForSelectorWithRetry(page, "iframe#Start");
    const startFrameHandle = await page.$("iframe#Start");
    const startFrame = await startFrameHandle.contentFrame();
    await waitForSelectorWithRetry(startFrame, "#menu_666_item", { visible: true });
    await Promise.all([
        startFrame.click("#menu_666_item"),
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
    ]);
    console.log('📁 "Mein Zeitmanagement" geöffnet.');
}

async function getUntenFrame(page) {
    await waitForSelectorWithRetry(page, "iframe#Unten");
    const untenFrameHandle = await page.$("iframe#Unten");
    return await untenFrameHandle.contentFrame();
}

// The widget shows one month. Its header has prev/next buttons and a hidden input holding
// the shown month as "YYYY-MM"; clicking a button reloads the widget's rows via XHR.
async function switchMonth(untenFrame, direction) {
    const monthInput = 'input[name="my-timemanagement_w-header-val"]';
    const button = `button.my-timemanagement_w-header-${direction}-button`;
    const before = await untenFrame.$eval(monthInput, (el) => el.value);

    // A click right after the widget re-rendered is sometimes swallowed, so click via DOM
    // (no scroll/coordinate dependency) and try again if the month value does not change.
    await retry(async () => {
        await untenFrame.$eval(button, (el) => el.click());
        await untenFrame.waitForFunction(
            (sel, prev) => document.querySelector(sel)?.value && document.querySelector(sel).value !== prev,
            { timeout: 8000 },
            monthInput,
            before
        );
    }, 3, 500, `switchMonth(${direction})`);

    await waitForSelectorWithRetry(untenFrame, "#my_timemanagement_widget tr.grid_row", { visible: true });
    const after = await untenFrame.$eval(monthInput, (el) => el.value);
    console.log(`📆 Widget zeigt jetzt ${after}.`);
}

async function collectDatesWithSaldo(untenFrame, saldoText) {
    return await untenFrame.evaluate((wantedSaldo) => {
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

async function openRowBookingForm(untenFrame, rowSelector) {
    const row = await untenFrame.$(rowSelector);
    if (!row) throw new Error(`Zeile nicht gefunden: ${rowSelector}`);

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
}

module.exports = {
    openMeinZeitmanagement,
    getUntenFrame,
    switchMonth,
    collectDatesWithSaldo,
    openRowBookingForm,
};
