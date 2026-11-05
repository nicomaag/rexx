// Push a short message to a webhook (Slack incoming webhook format: {"text": ...}).
// Does nothing when NOTIFY_WEBHOOK_URL is not set, never throws.
async function notify(text) {
    const url = process.env.NOTIFY_WEBHOOK_URL;
    if (!url) return;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) console.error(`⚠️  Benachrichtigung fehlgeschlagen: HTTP ${res.status}`);
    } catch (err) {
        console.error(`⚠️  Benachrichtigung fehlgeschlagen: ${err.message}`);
    }
}

module.exports = { notify };
