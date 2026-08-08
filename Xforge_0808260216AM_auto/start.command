#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (LTS version) and run this again."
  read -p "Press Enter to close..."
  exit 1
fi

# Start the server in the background, capture its port once it's written
rm -f .port
node server.js > /tmp/codex-agent-gui.log 2>&1 &
SERVER_PID=$!

# Wait for the server to report its port (up to ~10s)
for i in $(seq 1 50); do
  if [ -f .port ]; then break; fi
  sleep 0.2
done

if [ ! -f .port ]; then
  echo "Server didn't start. Log:"
  cat /tmp/codex-agent-gui.log
  read -p "Press Enter to close..."
  exit 1
fi

PORT=$(cat .port)
URL="http://localhost:$PORT"

# Prefer opening as a real app-style window (no address bar/tabs) via Chrome,
# Brave, or Edge if installed. Fall back to the default browser otherwise.
open_app_window() {
  for app in \
    "/Applications/Google Chrome.app" \
    "/Applications/Brave Browser.app" \
    "/Applications/Microsoft Edge.app"
  do
    if [ -d "$app" ]; then
      open -na "$app" --args --new-window "--app=$URL" --window-size=1180,760
      return 0
    fi
  done
  return 1
}

open_app_window || open "$URL"

echo "codex-agent is running at $URL"
echo "Closing this window will NOT stop the server — quit it from Activity Monitor"
echo "(process: node server.js) or close the app window and press Ctrl+C here."
wait $SERVER_PID
