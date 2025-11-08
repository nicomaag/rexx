const puppeteer = require("puppeteer");

async function launchBrowser({ debug = false, slowMo = 0 } = {}) {
    const browser = await puppeteer.launch({
        headless: !debug,
        slowMo,
        defaultViewport: null,
        dumpio: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    console.log("Chromium version:", await browser.version());
    if (debug) console.log(`🐢 Debug aktiv – slowMo=${slowMo}ms pro Aktion`);

    const page = await browser.newPage();
    browser.on("disconnected", () => console.error("🔌 [browser] disconnected"));
    return { browser, page };
}

module.exports = { launchBrowser };
