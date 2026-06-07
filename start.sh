#!/bin/sh
if [ "$SERVICE_TYPE" = "worker" ]; then
  exec node dist/worker.js
else
  exec node dist/server.js
fi
