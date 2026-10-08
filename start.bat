@echo off
title Launching FinSecure Voice Banking Stack
echo Pulling latest images...
docker compose pull
echo Starting all services...
docker compose up -d --no-build
echo.
echo ===================================================
echo System is live!
echo Bank Dashboard:    http://localhost:3001
echo Admin Console:     http://localhost:3000
echo ===================================================
pause