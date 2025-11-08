const { $x, waitForXPath, delay } = require("./utils");

// Close if open
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

// Try several strategies to open the dialog
async function openProjektDialogWithStrategies(formFrame, page) {
    // Already open?
    const already = await page.$('#time_pze_selection_layer');
    if (already) {
        const visible = await page.evaluate(el => {
            const s = window.getComputedStyle(el);
            return s && s.display !== 'none' && s.visibility !== 'hidden';
        }, already).catch(() => false);
        if (visible) return; // Layer already open
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

    // (1) Obvious triggers
    for (const sel of candidateSelectors) {
        const h = await formFrame.$(sel).catch(() => null);
        if (!h) continue;
        const txt = await formFrame.evaluate((el) => (el.textContent || el.getAttribute('aria-label') || '').trim(), h).catch(() => "");
        if (!/projekt|projekttätigkeit|project/i.test(txt)) continue;

        await formFrame.evaluate((el) => el.scrollIntoView({ behavior: "instant", block: "center" }), h);
        await h.click().catch(() => { });
        const ok = await page.waitForSelector('#time_pze_selection_layer', { visible: true, timeout: 2000 }).then(() => true).catch(() => false);
        if (ok) return;
    }

    // (2) Text-based fallback in form
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
        await el.click().catch(() => { });
        const ok = await page.waitForSelector('#time_pze_selection_layer', { visible: true, timeout: 2000 }).then(() => true).catch(() => false);
        if (ok) return;
    }

    // (3) Label-related activation (Enter/Space)
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

    // (4) Double click any likely trigger
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

// ===== Selection & Apply (idempotent) =====

const MODE_ALIASES = {
    Remote: ["Remote", "Homeoffice", "Home Office", "Home-Office", "Mobiles Arbeiten", "Mobile Arbeit"],
    Office: ["Office", "Büro", "Office Stuttgart", "Office Nürnberg", "Vor Ort", "Onsite"],
};

function normalizeText(s) {
    return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function getSelectedLeafText(page) {
    return await page.evaluate(() => {
        const node = document.querySelector('#rexxtree .dynatree-node.dynatree-selected') ||
            document.querySelector('#rexxtree .dynatree-radio input:checked')?.closest('.dynatree-node');
        if (!node) return "";
        const title = node.querySelector('.dynatree-title');
        if (!title) return (node.textContent || "").trim();
        return title.textContent.trim();
    }).catch(() => "");
}

async function isLeafSelected(page, leafHandle) {
    return await page.evaluate(el => {
        const node = el.closest('.dynatree-node') || el;
        if (node.classList.contains('dynatree-selected')) return true;
        const radio = node.querySelector('.dynatree-radio input, input[type=radio]');
        return !!(radio && radio.checked);
    }, leafHandle).catch(() => false);
}

async function handleProjektAuswahlDialogOnPage(page, mode, { nodeAnimDelay = 180, postSelectDelay = 250 } = {}) {
    const layer = await page
        .waitForSelector("#time_pze_selection_layer", { visible: true, timeout: 15000 })
        .catch(() => null);
    if (!layer) throw new Error("Projekt-Auswahl-Dialog wurde nicht angezeigt");

    const labels = MODE_ALIASES[mode] || [mode];

    // Already selected & matching?
    const currentText = await getSelectedLeafText(page);
    if (currentText) {
        const match = labels.some(lbl => normalizeText(currentText).includes(normalizeText(lbl)));
        if (match) {
            await delay(postSelectDelay);
            await clickApplyAndWaitClose(page);
            return;
        }
    }

    // Find any matching leaf
    let targetLeaf = await findAnyLeafMatchingMode(page, labels);
    if (!targetLeaf) {
        // try folder -> expand -> first matching leaf
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
            targetLeaf = await findAnyLeafMatchingMode(page, labels);
        }
    }

    if (!targetLeaf) throw new Error(`Kein Eintrag zu "${mode}" gefunden.`);

    // Select only if not already selected
    if (!await isLeafSelected(page, targetLeaf)) {
        await selectLeaf(page, targetLeaf, { nodeAnimDelay, postSelectDelay });
    }

    // Validate final selection
    const selectedText = await getSelectedLeafText(page);
    const ok = labels.some(lbl => normalizeText(selectedText).includes(normalizeText(lbl)));
    if (!ok) throw new Error(`Zielauswahl passt nicht: erwartet ${labels.join(" / ")}, gefunden: "${selectedText || "-"}"`);

    await clickApplyAndWaitClose(page);
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

async function selectLeaf(page, leafHandle, { nodeAnimDelay = 180, postSelectDelay = 250 } = {}) {
    // if already selected → just wait a bit
    if (await isLeafSelected(page, leafHandle)) {
        await delay(postSelectDelay);
        return;
    }

    const title = await leafHandle.$('.dynatree-title');
    if (title) { await title.click().catch(() => { }); await delay(nodeAnimDelay); }
    else { await leafHandle.click().catch(() => { }); await delay(nodeAnimDelay); }

    // Radio if exists & not checked
    const radio = await leafHandle.$(".dynatree-radio input, input[type=radio]");
    if (radio) {
        const already = await page.evaluate(inp => !!inp.checked, radio).catch(() => false);
        if (!already) await radio.click().catch(() => { });
    }

    // wait until selected
    await page.waitForFunction((el) => {
        const node = el.closest('.dynatree-node') || el;
        if (node.classList.contains('dynatree-selected')) return true;
        const r = node.querySelector('.dynatree-radio input, input[type=radio]');
        return !!(r && r.checked);
    }, { timeout: 3000 }, leafHandle).catch(() => { });

    await delay(postSelectDelay);
}

async function clickApplyAndWaitClose(page) {
    // require selection before applying
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

        // Alert?
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
            continue;
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

module.exports = {
    ensureProjektLayerClosed,
    openProjektDialogWithStrategies,
    handleProjektAuswahlDialogOnPage,
};
