const { waitForSelectorWithRetry } = require("./utils");

async function doLogin(page, user, pass) {
    await waitForSelectorWithRetry(page, "#loginform_username");
    await page.type("#loginform_username", user);
    await waitForSelectorWithRetry(page, "#password");
    await page.type("#password", pass);
    await waitForSelectorWithRetry(page, "#submit");
    await page.click("#submit");
}

module.exports = { doLogin };
