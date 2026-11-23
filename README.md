# Nearby

The "nearest fountain" demo, expanded into a Google Maps-style local search and directions app. Search for gas stations, parks, grocery stores, pharmacies, ATMs, fountains — or type anything else — then get routes, step-by-step directions, and a guided navigation simulation.

## Run

```bash
cd /home/opencode/projects/nearby
npm start
# open http://localhost:3000
```

No `npm install` is needed: the server uses only Node built-ins. The folder is deliberately flat — no vendored libraries or nested projects. MapLibre GL JS is loaded from a CDN at runtime (jsDelivr, with unpkg as fallback).

## What you can do

- **Search anything**: type a place name or a phrase such as `nearest gas station`, or tap one of the 16 category shortcuts. The radius (1–15 km) is adjustable.
- **Browse results**: nearest matches are listed with opening hours, address, and route time; the closest verified route is highlighted on the map.
- **Get directions**: choose a destination, pick Walking, Driving, or Cycling, and get a route with turn-by-turn steps. Origin and destination also accept place names or `lat, lon` coordinates.
- **Take me there**: press **Start** for a navigation view that follows the route at 25× speed, shows the next maneuver, remaining distance, and ETA.
- **Map controls**: zoom, bearing reset, real device geolocation ("Use my location"), and Map / Satellite / Dark layers. Move the map and press **Search this area** to recenter a search.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Google Maps-inspired interface |
| `app.js` | Map, search, markers, directions, navigation |
| `categories.js` | Shared category definitions and phrase interpretation |
| `server.js` | Static server + Overpass / Valhalla / Photon proxies and caching |
| CDN (jsDelivr → unpkg) | MapLibre GL JS, the only third-party runtime dependency |

## Data sources

- Places: OpenStreetMap via Overpass API.
- Routing and instructions: Valhalla (openstreetmap.de).
- Place-name lookup: Photon, with Nominatim as a fallback.
- Base map: OpenFreeMap; satellite imagery: Esri World Imagery.

There is no simulated starting point: the app asks for device location on launch (over HTTPS or `localhost`) and refuses to search until it has a real fix. If access is denied, use the **Use my location** button in the panel after enabling location in your browser settings. Public data services can be slow or rate-limited; the server retries several Overpass endpoints and caches responses for five minutes.

On phones the results panel is a draggable-style bottom sheet: tap the handle to expand it to nearly full screen. During navigation the search bar and sheet get out of the way so the route banner and map have the whole screen.
