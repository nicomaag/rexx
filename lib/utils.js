function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function retry(fn, retries = 2, delayMs = 1000, tag = "op") {
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

// CSS.escape polyfill for Node
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

// Minimal $x & waitForXPath used across modules
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

// Watchdog around a promise factory
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

module.exports = {
    delay,
    retry,
    waitForSelectorWithRetry,
    gotoWithRetry,
    cssEscape,
    $x,
    waitForXPath,
    withWatchdog,
};
