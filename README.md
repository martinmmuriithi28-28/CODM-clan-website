# Kenya One (K1) clan site

Your own site. No Claude account needed by anyone. Needs only Node 18 or newer. No packages to install.

## Run it
    OWNER_CODE=choose-an-8-digit-code node server.js
Open http://localhost:3000. Martin (roster #7) is the owner. Log in with "Log in", pick your name, type OWNER_CODE.
If you skip OWNER_CODE, a code is printed in the console and saved in data/owner-code.txt.

## Put it online
Any host that runs Node or Docker works (a small VPS, Render, Railway, Fly.io).
- Start command: `node server.js`
- Environment: `OWNER_CODE`, `PORT` (the host usually sets it), `TRUST_PROXY=1` behind a proxy, `DATA_DIR` = a folder on a PERSISTENT disk/volume.
- Docker: `docker build -t k1 .` then `docker run -d -p 80:3000 -v k1data:/data -e OWNER_CODE=12345678 k1`
- Use HTTPS (hosts like Render/Railway give it free).
Without a persistent disk the roster is lost on every restart.

## Daily use
- Anyone opens the link, picks "who are you" (saved on the phone), sees roster, scrims, updates.
- New members tap "Add me to the roster", then wait in Pending for a leader.
- Leaders: Leader setup > Login codes > pick member > Make a new code > Send on WhatsApp.
- Master can set roles (Leader, Vice Master, Master).

## Backup
Copy the DATA_DIR folder (data/db.json and uploads). Leaders can also download /api/export while logged in.
