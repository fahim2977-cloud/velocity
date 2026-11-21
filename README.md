# VELOCITY online setup (free)

You need 6 files, all in ONE GitHub repository:

- `index.html`   the game (hosted on GitHub Pages)
- `worker.js`    the match server (hosted on Cloudflare)
- `shared.js`    the movement + weapon rules (the server imports it; it is also built into index.html)
- `wrangler.toml`, `package.json`   settings Cloudflare reads

## Part 1: put the files on GitHub

1. Make a free account at github.com and tap **+ > New repository**.
2. Name it `velocity`, set it to **Public**, tap **Create repository**.
3. Tap **uploading an existing file** (or Add file > Upload files).
4. Upload all 6 files, then tap **Commit changes**.

## Part 2: host the game page (GitHub Pages)

1. In the repo go to **Settings > Pages**.
2. Under Branch pick `main` and `/ (root)`, tap **Save**.
3. After about a minute the game is at `https://YOURNAME.github.io/velocity`.

## Part 3: deploy the match server (Cloudflare)

1. Make a free account at cloudflare.com (no card needed).
2. Go to **Workers & Pages > Create application**, then choose to import a **Git repository**.
3. Connect GitHub when asked and pick your `velocity` repo.
4. IMPORTANT: the Worker name must be exactly `velocity-ffa` (it has to match `wrangler.toml`).
5. Leave the build command empty and the deploy command as `npx wrangler deploy`. Tap **Save and Deploy**.
6. When it finishes, open the Worker and copy its address. It looks like
   `https://velocity-ffa.YOURNAME.workers.dev`.
7. Open that address in your browser. You should see "Velocity FFA server is running."

(On a laptop you can skip the Git part: run `npm install` then `npx wrangler deploy` in the folder.)

## Part 4: connect the game to the server

Easiest: open your game with the server in the link (replace the bits):

`https://YOURNAME.github.io/velocity/?server=https://velocity-ffa.YOURNAME.workers.dev`

It is saved after the first time. Or open the game > ⚙ > SETTINGS and paste the address into **Server**.

Optional: open `index.html`, find `const DEFAULT_SERVER = ''` and put your server address between the quotes.
Then nobody ever has to type it.

## Playing

- **QUICK PLAY** puts you in the fullest public room that has space (rooms hold 12 players).
- **PRIVATE ROOM**: everyone who types the same code lands in the same match.
- Rifle: 16 body / 40 head. Shotgun: up to 88 up close, weaker far away. 100 HP, 3 second respawn.
- The server removes players who are silent for 15 seconds, or AFK for 2 minutes.

## Free limits (Cloudflare Workers Free plan)

100,000 requests/day, with WebSocket messages counted 20 to 1. The game sends 15 updates per second while you
move (about 2 per second when you stand still), so roughly 25 player-hours a day. If the limit is hit the server
stops accepting messages until midnight UTC; it never charges you on the free plan.

## How cheating is handled (server-authoritative)

Your browser only sends its **inputs** (keys, mouse angle, jump, fire). The server runs the same movement and
weapon code (`shared.js`) and decides where you are, how much ammo you have, and whether a shot hit.

- Speed hacks / teleports / flying / noclip: the server ignores them and pulls you back.
- Faster fire rate, infinite ammo, no reload: the server enforces cooldowns and ammo.
- Fake damage or hits: the browser cannot report hits at all, only the server judges shots.
- Shooting through walls: shots are checked against the real map.
- Lag is compensated (the server rewinds other players by your ping, up to 0.4 s).

What it can NOT stop: aimbots and wallhack-style cheats (they only read the screen and move the mouse).
No browser game can fully stop those. Rooms are 12 players max, so reporting/kicking by hand is realistic.

## Notes

- Free-plan cost: updates are 15 per second while you move, about 2 per second when you stand still.
- If you ever change the map seed or generator in `shared.js`, regenerate the `SPAWNS` list in it, or players
  may spawn inside containers. Re-paste the new `shared.js` into `index.html` too (it is a copy inside the page).
