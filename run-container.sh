#!/bin/bash
# Run this script to build and run the container (for manual use or cron)
docker build -t rexx-bot .
docker run --rm rexx-bot
