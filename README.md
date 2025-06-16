# rexx
Puppeteer script to automatically checkin into rexx.

## Docker Setup & Automation

### 1. Build the Docker Image (on your local machine)

```
docker build -t rexx-bot .
```

### 2. Push the Image to a Registry

Tag and push your image to Docker Hub or your preferred registry:

```
docker tag rexx-bot yourdockerhubusername/rexx-bot:latest

docker push yourdockerhubusername/rexx-bot:latest
```

### 3. Pull and Run the Container on Your Server

On your server, pull the image:

```
docker pull yourdockerhubusername/rexx-bot:latest
```

### 4. Automate with Cron (Linux Example)

Add this line to your crontab (edit with `crontab -e`):

```
0 20 * * * docker run --rm yourdockerhubusername/rexx-bot:latest
```

This will run the script every day at 20:00 (8pm). Adjust the time as needed.

### Notes
- The container is built and pushed from your local machine.
- The server only needs Docker and access to your image registry.
- The container is disposed after each run (`--rm`).
- Update the image on the server by pushing a new version from your machine and running `docker pull` again.

---
