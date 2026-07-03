# Blind Designs — Delivery Optimiser

Daily delivery planning for the Jhb/Pta van fleet: tick off the areas being served, import the day's orders, and get traffic-optimised routes split across two vans (a third is suggested automatically when two can't make the return cut-off). Produces a printable **delivery sheet PDF per van** — stop sequence, ETAs, phone numbers, tick boxes, a realistic *"aim to be back by"* time — plus **Google Maps navigation links/QR codes** for the drivers.

**Live app:** enable GitHub Pages (Settings → Pages → Deploy from branch → `main`, root) and the app runs at `https://<user>.github.io/<repo>/`. No server, no build step — everything runs in the browser and stays on your device.

## Daily workflow

1. **Open the app** — today's scheduled areas are pre-ticked (from the weekly schedule; edit in Settings).
2. **Import the day's orders** — upload the Excel/CSV export from your system (same layout as the deliveries report: Customer Name/Code, Delivery Address, Geographical Area, Order Number, Delivery Date). Rows are matched to the built-in address book; same-customer rows merge into one stop. Or add customers by hand from the Address book tab.
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

## Configuration (Settings tab)

| Setting | Default |
|---|---|
| Depot | 14–18 Ivanseth Rd, Reuven, Johannesburg |
| Depart / aim back / hard cut-off | 09:00 / 15:00 / 16:00 |
| Minutes per stop | 15 |
| Traffic leeway on "back by" | 12% |
| Weekly schedule | *Current* preset, plus a *Proposed* preset from the July 2026 delivery analysis; fully editable |

## Data & privacy

- **No customer data ships in this repo** (POPIA). Upload your customer list once via **Settings → Address book** (the "Customer addresses" tab of the ERP deliveries export works as-is); it is stored only in the browser's localStorage. Imported order files always carry their own addresses.
- `data-regions.js` — the nine delivery-region polygons from the Google My Maps area map + schedule presets.
- Geocodes, settings, day plans and tick-offs live in the browser (localStorage) — nothing is sent anywhere except Google Maps requests when a key is set.
- To update the address book, re-export from the ERP and upload again in Settings.

## Files

```
index.html            app shell
styles.css        styling
app.js             UI + day state + import + orchestration
optimiser.js       clustering, TSP (NN + 2-opt), Gauteng time model, timelines, Maps links
google.js          Google geocoding (cached) + traffic-aware Directions
pdfgen.js          per-van delivery sheet PDFs (jsPDF)
data-customers.js  address book (generated)
data-regions.js    region polygons, schedules, depot
```
