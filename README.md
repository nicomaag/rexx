# rexx
Puppeteer script to automatically checkin into rexx.

## Docker Setup & Automation

### 1. Build the Docker Image (on your local machine)

```
docker build -t rexx .
```

### 2. Push the Image to a Registry

Tag and push your image to Docker Hub or your preferred registry:

```
docker tag rexx nicomaa/rexx:latest

docker push nicomaa/rexx:latest
```

### 3. Pull and Run the Container on Your Server

On your server, pull the image:

```
docker pull nicomaa/rexx:latest
```

### 4. Automate with Cron (Linux Example)

To automate the script and save logs for each run, use the provided `run-container.sh` script in your cron job. This script will pull the latest image, run the container with your `.env` file, and save logs with a timestamped filename in your chosen log directory.

**Example crontab entry (runs every day at 20:00):**

```
0 20 * * * /data/rexx/run-container.sh
```

- Make sure `run-container.sh` is executable: `chmod +x /data/rexx/run-container.sh`
- Edit `run-container.sh` to set the correct paths for your log directory and `.env` file if needed.
- Logs will be saved in `/data/rexx/logs/` (or your configured directory) with a name like `rexx-YYYY-MM-DD_HH-MM-SS.log`.

To edit your crontab, run:
```
crontab -e
```
Then add the line above.

---

## Logging & Notifications

Each run will create a log file named like `rexx-bot-YYYY-MM-DD_HH-MM-SS.log` in your chosen log directory. Check these files to review the output or errors for any run.

## Environment Variables

Your script uses environment variables (e.g., `BENUTZERNAME`, `PASSWORT`).

### Option 1: Pass Variables Directly

```
docker run --rm -e BENUTZERNAME=youruser -e PASSWORT=yourpass nicomaa/rexx:latest
```

### Option 2: Use a .env File

1. Create a `.env` file with your variables:
   ```
   BENUTZERNAME=youruser
   PASSWORT=yourpass
   ```
2. Run the container with:
   ```
   docker run --rm --env-file /data/rexx/.env nicomaa/rexx:latest
   ```

**Note:** Do not commit your `.env` file to version control. Add `.env` to your `.dockerignore` and `.gitignore`.

---
