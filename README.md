# rexx
Puppeteer script to automatically create Rexx time bookings from the “Mein Zeitmanagement” list.

- Opens each row with saldo **`-8:00`** (once per day)
- Sets **start** (`Kommen`) and **end** (`Gehen`) time in the row’s form
- Selects **Project** via the global dialog as **Remote** or **Office** (weekday-based via ENV)
- Saves the form
- Robust retries/waits for iframes, dialogs and animations
- Debug mode to watch each step

---

## Features

- **Weekday-based Remote/Office selection** from ENV (`WEEKDAY_MODE`, `REMOTE_DAYS`, `OFFICE_DAYS`) with clear precedence
- **Idempotent** project selection (only changes if needed)
- **Retries & stability** around iframes and popups
- **Debug** mode to slow down actions: `--debug --slowmo=250`
- **CLI time overrides**: `--kommen=HH:MM --gehen=HH:MM`

---

## Environment Variables

At minimum:

```env
BENUTZERNAME=youruser
PASSWORT=yourpass
```

### Weekday → Mode Mapping (Remote/Office)

Define which weekdays are **Remote** vs **Office**. English and German short tokens supported.

**Precedence (highest first):**
1. `WEEKDAY_MODE` — explicit map  
   Example:
   ```env
   WEEKDAY_MODE=Mon:Remote,Tue:Office,Wed:Remote,Thu:Office,Fri:Remote
   ```
2. `REMOTE_DAYS` and/or `OFFICE_DAYS` — lists of weekdays  
   Examples:
   ```env
   REMOTE_DAYS=Mon,Fri
   OFFICE_DAYS=Tue,Wed,Thu
   ```
3. CLI fallback `--mode=Remote|Office` (used if ENV does not specify anything)

**Accepted weekday tokens:**

| English | German | Normalized |
|--------:|:------:|:----------:|
| Mon     | Mo     | Mon        |
| Tue     | Di     | Tue        |
| Wed     | Mi     | Wed        |
| Thu     | Do/Don | Thu        |
| Fri     | Fr     | Fri        |
| Sat     | Sa     | Sat        |
| Sun     | So     | Sun        |

> The script logs which mode is applied per day, e.g.  
> `🗓️  2025-11-03 (Mon) → Modus: Remote (ENV)`

### Optional tuning

```env
# Additional wait to accommodate UI animations (ms)
NODE_ANIM_DELAY_MS=180
```

---

## CLI Flags

- `--kommen=HH:MM` (default `09:00`)
- `--gehen=HH:MM` (default `18:00`)
- `--mode=Remote|Office` (fallback if ENV has no weekday rule)
- `--debug` (run headful and slow down steps)
- `--slowmo=250` (ms per action when `--debug` is used)

**Examples:**

```bash
node main.js
node main.js --kommen=08:30 --gehen=17:15
node main.js --debug --slowmo=250
node main.js --mode=Office
```

---

## Docker Setup & Automation

### 1. Build the Docker Image (locally)

```bash
docker build -t rexx .
```

### 2. Push the Image to a Registry

```bash
docker tag rexx nicomaa/rexx:latest
docker push nicomaa/rexx:latest
```

### 3. Pull the Image on Your Server

```bash
docker pull nicomaa/rexx:latest
```

### 4. Automate with Cron (Linux Example)

Use the provided `run-container.sh` to pull & run the latest image with your `.env` and save timestamped logs.

**Example crontab entry (runs every day at 20:00):**
```cron
0 20 * * * /data/rexx/run-container.sh
```

- Make sure `run-container.sh` is executable:
  ```bash
  chmod +x /data/rexx/run-container.sh
  ```
- Edit `run-container.sh` to point to your log directory and `.env`.
- Logs will be saved in `/data/rexx/logs/` (or your configured directory) with a name like `rexx-YYYY-MM-DD_HH-MM-SS.log`.

To edit your crontab:
```bash
crontab -e
```

---

## Logging

Each run creates a log file like `rexx-YYYY-MM-DD_HH-MM-SS.log` in your log directory.

---

## Dockerfile (reference)

```dockerfile
FROM node:20-slim

# Install Chromium and dependencies
RUN apt-get update && \
    apt-get install -y chromium chromium-driver && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .

# Set Puppeteer to use system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "main.js"]
```

---

## Using `.env` with Docker

**Option 1: Pass variables directly**
```bash
docker run --rm \
  -e BENUTZERNAME=youruser \
  -e PASSWORT=yourpass \
  -e WEEKDAY_MODE="Mon:Remote,Tue:Office,Wed:Remote,Thu:Office,Fri:Remote" \
  nicomaa/rexx:latest
```

**Option 2: Use a `.env` file**

```env
BENUTZERNAME=youruser
PASSWORT=yourpass
WEEKDAY_MODE=Mon:Remote,Tue:Office,Wed:Remote,Thu:Office,Fri:Remote
# or:
# REMOTE_DAYS=Mon,Fri
# OFFICE_DAYS=Tue,Wed,Thu

# Optional:
# NODE_ANIM_DELAY_MS=180
```

Run with:
```bash
docker run --rm --env-file /data/rexx/.env nicomaa/rexx:latest
```

**Note:** Do not commit your `.env` to version control. Add `.env` to `.dockerignore` and `.gitignore`.

---

## Troubleshooting

- **Dialog opens but selection doesn’t “stick”**  
  Increase animation delay: `NODE_ANIM_DELAY_MS=220` (or run `--debug --slowmo=250` to observe timings).

- **Occasional “not found” selectors**  
  The script includes robust retries; transient iframe reloads should be handled automatically. If persistent, re-run with `--debug`.

- **Different project tree labels**  
  The code expects top-level nodes named **Remote** and **Office**. If your instance uses different labels, adjust the environment mapping or update the selectors accordingly.

---

## License

Private/internal use.
