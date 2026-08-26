FROM node:22-slim

# Chromium from apt, and only Chromium.
#
# chromium-driver was installed alongside it. That is the WebDriver binary, for
# Selenium and anything else speaking the W3C WebDriver protocol. This app
# drives the browser with Puppeteer, which speaks the DevTools protocol
# directly over a socket and never launches a driver.
#
# --no-install-recommends because apt otherwise pulls in fonts, icon themes and
# assorted desktop pieces that a headless browser has no use for.
RUN apt-get update && \
    apt-get install -y --no-install-recommends chromium && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Two browsers were being installed, and only one was ever opened.
#
# `puppeteer` (as opposed to `puppeteer-core`) downloads its own Chrome build on
# install unless told not to — several hundred megabytes of it. But
# PUPPETEER_EXECUTABLE_PATH points launch() at the apt Chromium above, so that
# download sat in the image untouched for the life of every container.
#
# Set before the install, because that is when the download happens.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json package-lock.json ./
# `npm ci`, not `npm install --production`: install resolves against
# package.json and may pick versions the lockfile does not name, which is the
# one thing a lockfile exists to prevent.
RUN npm ci --omit=dev

COPY . .

CMD ["node", "main.js"]
