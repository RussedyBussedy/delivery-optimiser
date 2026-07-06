# Blind Designs — Delivery Optimiser

Daily delivery planning for the Jhb/Pta van fleet: tick off the areas being served, import the day's orders, and get traffic-optimised routes split across two vans (a third is suggested automatically when two can't make the return cut-off). Produces a printable **delivery sheet PDF per van** — stop sequence, ETAs, phone numbers, tick boxes, a realistic *"aim to be back by"* time — plus **Google Maps navigation links/QR codes** for the drivers.

**Live app:** enable GitHub Pages (Settings → Pages → Deploy from branch → `main`, root) and the app runs at `https://<user>.github.io/<repo>/`. No server, no build step — everything runs in the browser and stays on your device.

## Daily workflow

1. **Open the app** — today's scheduled areas are pre-ticked (from the weekly schedule; edit in Settings).
2. **Import the day's orders** — upload the Excel/CSV export from your system (same layout as the deliveries report: Customer Name/Code, Delivery Address, Geographical Area, Order Number, Delivery Date). Rows are matched to the built-in address book; same-customer rows merge into one stop. Or add customers by hand: **Address book tab → ＋ New customer** (name, address, phone, area — the address is pinned on the map immediately when a Google key is set), and ✎ / ✕ to edit or remove existing ones.
3. **Optimise routes** — stops are clustered into two compact routes by drive-time (not by region label), sequenced with live traffic when a Google key is set, and timed: depart 09:00, 15 min per stop.
4. **Review** — if the two-van plan can't beat the 16:00 hard cut-off, the app computes the 3-van alternative and asks before splitting. Move any stop between vans with ⇄, then Re-optimise.
5. **Print/send the PDFs** — one per van, with QR codes the driver scans to open the route in Google Maps. Tick stops off in the app as the day progresses (saved per date).

## Google Maps API key (10-minute one-time setup)

The app works without a key (offline speed model with Gauteng rush-hour factors), but a key adds **live traffic, waypoint optimisation and precise geocoding**.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → sign in with a Google account.
2. Create a project (e.g. `bd-delivery`). 
3. **Billing → Link a billing account** (card required; Google's free monthly allowance covers this app's usage many times over at ~2 vans/day — expect R0 on the invoice, but set a [budget alert](https://console.cloud.google.com/billing/budgets) at e.g. R200 for peace of mind).
4. **APIs & Services → Library** → enable: **Maps JavaScript API**, **Directions API**, **Geocoding API**.
5. **APIs & Services → Credentials → Create credentials → API key.**
6. Restrict the key (Edit key → Application restrictions → *Websites* → add `https://<your-user>.github.io/*`; API restrictions → the three APIs above).
7. Paste the key into the app: **Settings → Google Maps API key → Save**. It is stored only in your browser's localStorage.
8. Upload the address book (Settings), then run **Settings → “Geocode entire address book”** once per device so daily optimisation is instant.

Typical usage ≈ 1 geocode per new address + 2–3 Directions calls per day — comfortably inside the free tier.

**If the key doesn't seem to work:** after "Save settings" the app now tests the key and prints the exact reason under the key field. The usual culprits are: the **Geocoding API** not enabled (it's a separate toggle from Maps JavaScript API), **billing not linked**, or the key's website restriction not matching `https://<your-user>.github.io/*`.

## Team sync (share settings & addresses with everyone) — 15-minute one-time setup

Without sync, everything lives per-browser. With sync, **settings (including the Google key), the address book and all geocodes** are shared automatically across every device, via a free Firebase project that you own. Day plans and tick-offs stay per device.

One person does this once:

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (e.g. `bd-delivery-sync`; Google Analytics off).
2. **Build → Firestore Database → Create database** → *Start in production mode* → location: `africa-south1` (Johannesburg) if offered, else a `europe-west` region.
3. **Rules** tab → replace the contents with the rules in [`firestore.rules`](firestore.rules) → **Publish**.
4. **Project settings (⚙) → Your apps → Web (`</>`)** → register app (no hosting) → copy the `firebaseConfig = { … }` object.
5. Paste that object into `firebase-config.js` in this repo and push — **this is safe to publish**: the config is not a secret; the data is protected by the rules plus the random team code. (Alternative: skip this step and paste the config in Settings → Team sync on each device instead.)
6. In the app: **Settings → Team sync → Create new team** → copy the generated team code and share it **privately** with staff (WhatsApp/email — it's the password to your data).
7. Everyone else: **Settings → Team sync →** enter the team code → **Connect**. Done — their browser pulls the address book, settings, key and geocodes, and stays in sync from then on.

How it behaves: changes sync within a second or two; last write wins; if someone is offline the app keeps working from its local copy and catches up later. "Turn off on this device" stops syncing locally without deleting anything in the cloud.

**Privacy (POPIA):** customer data still never goes into this repo. It lives in *your* Firebase project, readable only by someone who has the team code — treat the code like a password. To lock a leaked code out, create a new team (Settings → Create new team) and share the new code.

## Configuration (Settings tab)

| Setting | Default |
|---|---|
| Depot | 14–18 Ivanseth Rd, Reuven, Johannesburg |
| Depart / aim back / hard cut-off | 09:00 / 15:00 / 16:00 |
| Minutes per stop | 15 |
| Traffic leeway on "back by" | 12% |
| Weekly schedule | *Current* preset, plus a *Proposed* preset from the July 2026 delivery analysis; fully editable |

## Data & privacy

- **No customer data ships in this repo** (POPIA). Upload your customer list once via **Settings → Address book** (the "Customer addresses" tab of the ERP deliveries export works as-is). Imported order files always carry their own addresses.
- `data-regions.js` — the nine delivery-region polygons from the Google My Maps area map + schedule presets.
- Without Team sync: geocodes, settings, day plans and tick-offs live in the browser (localStorage) — nothing is sent anywhere except Google Maps requests when a key is set. With Team sync: settings, address book and geocodes are also stored in your own Firebase project (see Team sync section); day plans and tick-offs remain per device.
- To update the address book, re-export from the ERP and upload again in Settings (it syncs to the team automatically), or edit individual customers in the Address book tab.

## Files

```
index.html            app shell
styles.css         styling
app.js             UI + day state + import + orchestration
optimiser.js       clustering, TSP (NN + 2-opt), Gauteng time model, timelines, Maps links
google.js          Google geocoding (cached) + traffic-aware Directions
sync.js            Team sync via Firebase Firestore (optional)
firebase-config.js Firebase web config (safe to publish; null = sync off)
firestore.rules    security rules to paste into the Firebase console
pdfgen.js          per-van delivery sheet PDFs (jsPDF)
data-customers.js  address book (generated)
data-regions.js    region polygons, schedules, depot
```
