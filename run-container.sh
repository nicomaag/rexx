#!/bin/bash
# Run this script to pull and run the container, saving logs with a timestamped filename

IMAGE="nicomaa/rexx:latest"
LOG_DIR="/data/rexx/logs" # Change this to your desired log directory
ENV_FILE_DIR="/data/rexx/.env" # Change this to your desired env file directory
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/rexx-$(date +"%Y-%m-%d_%H-%M-%S").log"

docker pull "$IMAGE"
docker run --rm --env-file "$ENV_FILE_DIR" "$IMAGE" > "$LOG_FILE" 2>&1