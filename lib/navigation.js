const { waitForSelectorWithRetry } = require("./utils");

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
    collectDatesWithSaldo,
    openRowBookingForm,
};
