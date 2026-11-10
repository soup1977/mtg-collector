# MTG Collector

A local collection tracker that answers the question Archidekt won't: **which of my decks use this card?**

- Imports your Archidekt collection CSV and deck exports (CSV preferred, text also works)
- Pulls all card data and images from Scryfall (cached in `data/mtg.sqlite`)
- Card page lists every deck using the card, every printing you own, and owned vs. needed
- Flags cards used in more decks than you own copies of (basic lands ignored)
- Edit decks in the app: add (Scryfall autocomplete), remove, change quantities and categories

## Run

```sh
npm install
npm run build      # build the UI once (or after UI changes)
npm start          # http://localhost:3001
```

For UI development with hot reload: `npm run dev`, then open http://localhost:5173.

By default the server only listens on this computer (`127.0.0.1`). To reach it from other devices, set
`HOST=0.0.0.0` **and** `APP_PASSWORD`; the server refuses to listen on the network without a password.

## Security

| Variable | What it does |
|---|---|
| `APP_PASSWORD` | Login password. Sessions last 30 days; changing the password logs everyone out. 10 failed logins per 15 minutes per client. |
| `HOST` | Address to listen on. Default `127.0.0.1`. |
| `ALLOWED_HOSTS` | Without a password, only `localhost` is served (blocks DNS rebinding). Add other hostnames here, comma-separated. |
| `TRUST_PROXY=1` | Behind a reverse proxy that terminates HTTPS (makes the login cookie `Secure`). |
| `SESSION_SECRET` | Optional. Otherwise a random secret is kept in `.session-secret` next to the database. |

Every request that changes data must come from the app itself (`X-MTG-Client` header, same-origin fetch
metadata), so other websites you visit can't make changes. Don't port-forward the app to the internet; use
Tailscale or a VPN for access away from home.

## Docker / Unraid

Pushing to `main` runs the tests and publishes `ghcr.io/soup1977/mtg-collector:latest` (GitHub Actions,
[.github/workflows/docker.yml](.github/workflows/docker.yml)).

**First install on Unraid (Compose Manager plugin):**
1. Docker tab → **Add New Stack**, name it `mtg-collector`.
2. **Edit Stack → Compose File**: paste [docker-compose.yml](docker-compose.yml).
3. **Edit Stack → ENV File**: `APP_PASSWORD=your-password`.
4. **Compose Up**, then open `http://tower:3077`.

(Prefer Unraid templates? [unraid/mtg-collector.xml](unraid/mtg-collector.xml) does the same through **Add Container**.)

| Container | Unraid | |
|---|---|---|
| port `3077` | `3077` | web UI |
| `/data` | `/mnt/cache/appdata/mtg-collector` | database. Keep it on the cache drive (SQLite and `/mnt/user` don't mix well). |
| `/backups` | `/mnt/user/backups/mtg-collector` | daily backups (Backup settings are fixed to this folder in the container) |
| `APP_PASSWORD` | | required |

**Moving your data from the Mac:** in the Mac app, **Settings → Back up now**, then stop it. Open the app on
Unraid, **Settings → Restore → From a file on this computer**, and pick that backup's `mtg.sqlite`. The file is
checked first (it must be an intact MTG Collector database), and a safety copy of the current state is saved.

**Updating:** push to `main`, wait for the GitHub Action to finish, then in Compose Manager **Update Stack**
(pulls the new image and restarts).

**Claude (MCP) with the app on Unraid:** set up SSH keys to the server, then use
[.mcp.unraid.example.json](.mcp.unraid.example.json) as your `.mcp.json` (Claude runs the MCP server inside the
container over SSH).

## Import

In the app: **Import** page. Or from the command line:

```sh
npm run import:collection -- archidekt-collection-export.csv
npm run import:deck -- saskia.csv "Saskia"          # add --replace to overwrite
```

- Re-importing the collection replaces what you own; decks stay linked.
- Decks link to cards by Scryfall oracle id, so any printing you own counts toward a deck.

## Verifying decks

Archidekt deck lists often show a printing you don't own even when you have the card. Open a deck, then:

1. **Auto-fix printings:** for cards whose listed printing you don't own, switch to the one printing you do own (when there's exactly one with a free copy). Nothing is confirmed yet.
2. **Verify deck → Scan pile** (default, made for shuffled decks): pick up any card and type its set code and
   collector number, e.g. `blc 283` or `one 12 f`. The app finds which card in the deck it is, switches the deck to
   that printing if Archidekt listed a different one, and logs the copy in your collection if it wasn't there.
   **Older cards without a set code:** type the name instead (suggestions come from the deck), then pick the
   printing by picture: owned printings first, then every printing oldest to newest (keys 1–9, Enter).
   **The physical deck wins:** a card you scan that isn't on the list is added to the deck (it notes other decks that list it).
   It flags duplicates and skips basic lands. Every scan has Undo. When the pile is done, the cards you didn't
   scan were either **swapped out** (removed from the deck; × for single cards) or **missing** (kept, flagged).
3. **Verify deck → Card by card:** the app walks the deck list in order instead.
   - Type the set code and collector number, e.g. `dsc 94`, `one 12 f` (foil), `c16 41 e` (etched), then Enter. Or
   - Pick a printing (keys 1–9; "Show all printings" for ones you don't own) and press Enter. Or
   - `M` = missing / proxy, `S` or `→` = skip, `←` = back.
4. Confirming a printing claims real copies of it. If your collection doesn't have enough free copies (none logged, or claimed by another deck), the difference is **added to your collection** and logged.

The **Changes** page lists everything the app added, with undo and a CSV export in Archidekt's collection format.

This app is the master record of your collection: re-importing an Archidekt CSV **merges** (adds new cards, never removes). Use `--replace` / the checkbox to start over. Re-importing a deck keeps your verification for cards still in it.

## Swapping cards and the Considering list

Adding a card on a deck page asks what it's for:
- **Swap a card out:** pick the card leaving (same card type is suggested first). It either leaves the deck
  (freed in your collection) or moves to **Considering**. The new card takes its category.
- **Add to Considering:** the deck's maybe list. These cards don't count toward the deck (count, value,
  shortfalls, verification) and never claim copies. The collection shows them as "considered: Deck".
- **Just add.**

Each Considering card can name the deck card it **would replace** (picker under its name, or in the add
dialog). That deck card shows "↔ New Card?", and **⇄ Swap in** makes the swap in one click: the new card takes
the old one's category and the old one moves to Considering. Re-importing a deck from Archidekt keeps
Considering cards you added in the app.

⇣ / ⇡ on a row moves a card between the deck and Considering. Archidekt's *Maybeboard* and *Sideboard*
categories import straight into Considering. Each deck keeps a **History** of swaps, adds, removals and moves.
Scan pile mode doesn't use any of this. It's for the initial clean-up.

## Deck problems

Each deck has a **format** (picker next to the deck name; defaults to Commander). Decks that break its rules
are shaded on the Decks page with the problems listed, and the deck page shows a **Problems** panel and flags
the cards involved.

- **Commander:** exactly 100 cards (commander included), a commander set, singleton (basic lands and
  "any number of cards named" / "up to seven" cards allowed), every card inside the commander's color
  identity, nothing banned.
- **Standard / Pioneer / Modern / Legacy / Pauper:** at least 60 cards, at most 4 copies, legal in the format.
- **Casual:** no checks.

Considering cards are never checked. Legality comes from Scryfall.

## Dissolving decks

For a deck you've raided or taken apart: **Dissolve deck** keeps the list (under *Archived* on the Decks page)
but its cards stop counting as used. They're free in your collection, with no shortfalls or claimed copies.
**Restore deck** brings it back and lists any cards that are now short because other decks use them.
**Delete** removes the list for good. Either way, the cards stay in your collection.

## Prices

TCGplayer market prices (USD), supplied by Scryfall and matched to each copy's finish (normal, foil, etched).
They show on the collection grid/table (sort by price or value owned), card pages, deck pages (deck value,
cost to complete) and as the collection total in the header.

**Settings** page:
- **Bulk:** cards under a threshold (default $1.00) show "bulk" instead of a price and aren't counted in totals.
  Change the threshold or turn it off.
- **Refresh prices now.** Prices also refresh automatically when the server starts if they're over a day old
  (set `NO_PRICE_REFRESH=1` to skip).

## Backups

**Settings → Backups.** Each backup is a folder named `MTG Collector Backups/<date_time>/` containing:
- `mtg.sqlite`: everything (restore it from Settings, from the backup list or by uploading the file)
- `collection.csv`: Archidekt-format collection
- `decks/*.txt`: every deck as a list (Considering cards under `[Maybeboard]`)

Destinations: **personal OneDrive** (default; appears once a personal account is signed in to the OneDrive app),
**iCloud Drive**, or a **custom folder**. Backups run daily (configurable) and with **Back up now**, keeping the last 30.
**Restore** replaces the live data in place and saves a safety copy of the current state to `data/pre-restore/` first.
The live database is never stored in a synced folder; syncing an open database can corrupt it.

## Claude (MCP)

`server/mcp.js` is an MCP server giving Claude read access to your collection and decks, plus one write tool:

| Tool | What it does |
|---|---|
| `collection_summary` | totals, value, free copies by color identity |
| `list_decks` | every deck: commander, colors, count, problems, value |
| `get_deck` | full list by category, curve, type counts, owned / other decks, Considering |
| `search_collection` | filter by name, rules text, type, color identity fit, mana value, price, free/unused |
| `get_card` | one card: text, legality, owned printings, decks |
| `add_to_considering` | put suggestions on a deck's Considering list, optionally with the card each would `replaces` (never the main deck or collection) |

- **Claude Code:** `.mcp.json` in this folder registers it (not committed; see `.mcp.unraid.example.json`); approve it when Claude Code asks.
- **Claude desktop app:** quit the app, run `npm run claude:install`, and reopen it.

## Tests

```sh
npm test
```
