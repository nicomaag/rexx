@echo off
REM Run this script to execute the container (for Windows Task Scheduler or manual use)
docker build -t rexx .
docker run --rm rexx
