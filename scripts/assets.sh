#!/bin/sh
set -e
if [ ! -f assets/seahorse.png ]; then
  echo "error: assets/seahorse.png missing (needs the DARK-background artwork)" >&2
  exit 1
fi
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1280,640 \
  --screenshot=assets/social-preview.png assets/social-preview.html 2>/dev/null
echo "wrote assets/social-preview.png"
