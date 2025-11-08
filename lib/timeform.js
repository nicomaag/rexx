const { $x, retry, waitForSelectorWithRetry } = require("./utils");

// Wait until we have at least two time inputs in the form
async function waitForTimeInputsStable(formFrame) {
    await formFrame.waitForFunction(() => {
        const box = document.querySelector('#row_ZEIT');
        if (!box) return false;
        const inputs = box.querySelectorAll('input.stdformelem_time');
        return inputs && inputs.length >= 2;
    }, { timeout: 8000 });
}

/**
 * Fill both inputs reliably and dispatch events.
 */
async function setTimeInForm(formFrame, { kommen, gehen }) {
    const fromCandidates = ['[id="1173_from"]', '[name="1173[from]"]', '#row_ZEIT input.stdformelem_time:first-of-type'];
    const toCandidates = ['[id="1173_to"]', '[name="1173[to]"]', '#row_ZEIT input.stdformelem_time:nth-of-type(2)'];

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

    if (!fromInput && !toInput) throw new Error("Zeit-Eingabefelder im Formular nicht gefunden");
    if (!fromInput) throw new Error("Start-Eingabefeld im Formular nicht gefunden");
    if (!toInput) throw new Error("End-Eingabefeld im Formular nicht gefunden");

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

    await fill(fromInput, kommen);
    await new Promise(r => setTimeout(r, 80));
    await fill(toInput, gehen);
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
    await btn.click().catch(() => { }); // robustClick unnecessary here; simple DOM

    // Wait for the form iframe to disappear
    await untenFrame
        .waitForSelector("iframe#time_workflow_form_layer_iframe", { hidden: true, timeout: 30000 })
        .catch(async () => {
            await formFrame.waitForSelector("a#application_creation_toolbar_save", { hidden: true, timeout: 10000 }).catch(() => { });
        });

    // Widget visible/refreshed
    await retry(
        () => waitForSelectorWithRetry(untenFrame, "div#my_timemanagement_widget", { visible: true }),
        2,
        800,
        "widgetRefresh"
    ).catch(() => { });
}

module.exports = {
    waitForTimeInputsStable,
    setTimeInForm,
    saveAndCloseForm,
};
