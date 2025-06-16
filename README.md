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

For timestamped log files, use the provided `run-container.sh` script. This will save each run's logs with the date and time in the filename:

```
0 20 * * * /data/rexx/run-container.sh
```

Edit `run-container.sh` to set your desired log directory (default: `/data/rexx/logs`).

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
