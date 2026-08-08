#!/bin/bash
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it (e.g. 'sudo apt install nodejs') and run this again."
  read -p "Press Enter to close..."
  exit 1
fi

rm -f .port
node server.js > /tmp/codex-agent-gui.log 2>&1 &
SERVER_PID=$!

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

open_app_window() {
  for bin in google-chrome chromium-browser chromium brave-browser microsoft-edge; do
    if command -v "$bin" >/dev/null 2>&1; then
      "$bin" --new-window "--app=$URL" --window-size=1180,760 >/dev/null 2>&1 &
      return 0
    fi
  done
  return 1
}

open_app_window || xdg-open "$URL" >/dev/null 2>&1

echo "codex-agent is running at $URL"
echo "Press Ctrl+C here to stop the server."
wait $SERVER_PID
