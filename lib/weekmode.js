// Build weekday resolver (ENV + fallback)

function normalizeWeekToken(tokRaw) {
    if (!tokRaw) return null;
    const t = String(tokRaw).trim().toLowerCase();
    const map = {
        mon: "Mon", mo: "Mon",
        tue: "Tue", di: "Tue",
        wed: "Wed", mi: "Wed",
        thu: "Thu", don: "Thu", do: "Thu",
        fri: "Fri", fr: "Fri",
        sat: "Sat", sa: "Sat",
        sun: "Sun", so: "Sun",
    };
    if (t.startsWith("mon")) return "Mon";
    if (t.startsWith("tue")) return "Tue";
    if (t.startsWith("wed")) return "Wed";
    if (t.startsWith("thu")) return "Thu";
    if (t.startsWith("fri")) return "Fri";
    if (t.startsWith("sat")) return "Sat";
    if (t.startsWith("sun")) return "Sun";
    return map[t] || null;
}

function buildWeekdayModeMapFromEnv() {
    const map = {};
    const parseMode = (v) => (String(v || "").toLowerCase().startsWith("off") ? "Office" : "Remote");

    // 1) WEEKDAY_MODE
    const str = process.env.WEEKDAY_MODE;
    if (str) {
        for (const part of str.split(",")) {
            const [kRaw, vRaw] = part.split(":");
            const key = normalizeWeekToken(kRaw);
            if (!key) continue;
            const mode = parseMode(vRaw);
            map[key] = mode;
        }
    }

    // 2) REMOTE_DAYS / OFFICE_DAYS
    const addDays = (list, mode) => {
        if (!list) return;
        for (const tok of list.split(",")) {
            const key = normalizeWeekToken(tok);
            if (key) map[key] = mode;
        }
    };
    if (process.env.REMOTE_DAYS) addDays(process.env.REMOTE_DAYS, "Remote");
    if (process.env.OFFICE_DAYS) addDays(process.env.OFFICE_DAYS, "Office");

    return map;
}

function weekdayFromDateId(dateId) {
    const [y, m, d] = dateId.split("-").map((n) => parseInt(n, 10));
    const dt = new Date(Date.UTC(y, m - 1, d));
    const idx = dt.getUTCDay(); // 0=Sun..6=Sat
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][idx];
}

function buildWeekdayModeResolver(defaultMode) {
    const map = buildWeekdayModeMapFromEnv();
    return function resolve(dateId) {
        const wd = weekdayFromDateId(dateId);
        return map[wd] || defaultMode;
    };
}

function getModeForDate(dateId, resolver) {
    const wd = weekdayFromDateId(dateId);
    const mode = resolver(dateId);
    const hint = process.env.WEEKDAY_MODE || process.env.REMOTE_DAYS || process.env.OFFICE_DAYS ? "ENV" : "Fallback CLI";
    console.log(`🗓️  ${dateId} (${wd}) → Modus: ${mode} (${hint})`);
    return mode;
}

module.exports = {
    buildWeekdayModeResolver,
    getModeForDate,
};
