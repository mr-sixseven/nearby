import { CATEGORIES, CATEGORY_BY_ID, interpretQuery, OTHER_CATEGORY } from './categories.js';

// The map library is an external dependency, not a nested project in this folder.
async function ensureMapLibre() {
  if (window.maplibregl) return;
  const sources = [
    'https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.js',
    'https://unpkg.com/maplibre-gl@5.6.0/dist/maplibre-gl.js'
  ];
  for (const src of sources) {
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(script);
      });
      if (window.maplibregl) return;
    } catch (error) {
      console.warn(error.message);
    }
  }
  document.getElementById('resultsStatus')?.replaceChildren('The map library could not be loaded. Check your connection and reload.');
  throw new Error('MapLibre GL JS is unavailable.');
}

await ensureMapLibre();
const maplibregl = window.maplibregl;

const $ = (id) => document.getElementById(id);

const STYLES = {
  map: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
  satellite: {
    version: 8,
    sources: {
      imagery: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
      }
    },
    layers: [{ id: 'imagery', type: 'raster', source: 'imagery' }]
  }
};

const MODE_LABEL = { walk: 'walking', drive: 'driving', bike: 'cycling' };
const MODE_SPEED = { walk: 1.4, bike: 4.8, drive: 9 };

const state = {
  center: null,
  centerLabel: '',
  origin: null,
  destination: null,
  radius: 5000,
  activeCategory: null,
  lastQuery: '',
  hasSearched: false,
  places: [],
  selectedId: null,
  mode: 'walk',
  route: null,
  nav: null,
  lastSearchCenter: null,
  styleId: 'map'
};

const placeMarkers = new Map();
let userMarker = null;
let navMarker = null;
let endpointMarkers = [];
let routeCoordinates = [];
let toastTimer = null;
let searchSequence = 0;

/* ------------------------------ Map ------------------------------ */

const map = new maplibregl.Map({
  container: 'map',
  style: STYLES[state.styleId],
  center: [0, 0],
  zoom: 2,
  attributionControl: false
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.touchZoomRotate.disableRotation();

function installRouteLayer() {
  if (!map.isStyleLoaded()) return;
  if (!map.getSource('nearby-route')) {
    map.addSource('nearby-route', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
  }
  if (!map.getLayer('nearby-route-casing')) {
    map.addLayer({
      id: 'nearby-route-casing',
      type: 'line',
      source: 'nearby-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 11, 'line-opacity': 0.95 }
    });
  }
  if (!map.getLayer('nearby-route-line')) {
    map.addLayer({
      id: 'nearby-route-line',
      type: 'line',
      source: 'nearby-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1a73e8', 'line-width': 6, 'line-opacity': 0.95 }
    });
  }
  drawRoute(routeCoordinates);
}

map.on('load', installRouteLayer);
map.on('style.load', installRouteLayer);

function drawRoute(coordinates) {
  routeCoordinates = coordinates || [];
  const source = map.getSource('nearby-route');
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: routeCoordinates.length > 1
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routeCoordinates } }]
      : []
  });
}

function sheetHeight() {
  return $('panel').hidden ? 0 : $('panel').getBoundingClientRect().height;
}

function updateSheetInset() {
  if (window.innerWidth > 720) {
    document.body.style.removeProperty('--sheet-inset');
    return;
  }
  document.body.style.setProperty('--sheet-inset', `${Math.round(sheetHeight())}px`);
}

function cameraPadding(extraTop = 0) {
  if (window.innerWidth <= 720) {
    return {
      top: ($('navBanner').hidden ? 120 : 90) + extraTop,
      right: 24,
      bottom: Math.min(sheetHeight() + 24, window.innerHeight * 0.75),
      left: 24
    };
  }
  return { left: $('panel').hidden ? 0 : 440, right: 80, top: 100 + extraTop, bottom: 80 };
}

function setMapPadding() {
  const mobile = window.innerWidth <= 720;
  const padding = mobile
    ? { left: 0, right: 0, top: $('navBanner').hidden ? 120 : 90, bottom: Math.min(sheetHeight() + 16, window.innerHeight * 0.75) }
    : { left: $('panel').hidden ? 0 : 416, right: 0, top: 0, bottom: 0 };
  updateSheetInset();
  if (typeof map.setPadding === 'function') map.setPadding(padding);
  else map.jumpTo({ padding });
}

/* --------------------------- Small helpers --------------------------- */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function formatDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.max(1, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 60) return '< 1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function haversine(a, b) {
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
  const rad = (d) => d * Math.PI / 180;
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function toast(message, duration = 3600) {
  const element = $('toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, duration);
}

/* --------------------------------- Location --------------------------------- */

let locating = false;

function showLocationError(message) {
  $('locationGate').hidden = false;
  $('resultsSubtitle').textContent = 'Location access required';
  setInlineStatus($('resultsStatus'), message, true);
  $('resultList').innerHTML = '';
}

function requestLocation() {
  if (state.origin) return;
  if (locating) return;
  if (!navigator.geolocation) {
    showLocationError('This browser cannot share a location. Use a browser with geolocation support.');
    return;
  }

  locating = true;
  switchView('results');
  $('locationGate').hidden = false;
  setInlineStatus($('resultsStatus'), 'Waiting for your location…');
  navigator.geolocation.getCurrentPosition((position) => {
    locating = false;
    const next = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      label: 'Your location'
    };
    state.origin = next;
    state.center = next;
    state.centerLabel = 'your location';
    state.lastSearchCenter = { lat: next.lat, lon: next.lon };
    $('originInput').value = next.label;
    $('locationGate').hidden = true;
    updateUserMarker(next);
    renderWelcome();
    map.flyTo({ center: [next.lon, next.lat], zoom: 16, duration: 1100 });
    toast('Found your location.');
  }, (error) => {
    locating = false;
    showLocationError(error?.message
      ? `Location unavailable: ${error.message}`
      : 'Location access was denied. Allow it in your browser settings, then tap “Use my location”.');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

function requireLocation() {
  if (state.origin) return true;
  switchView('results');
  $('locationGate').hidden = false;
  setInlineStatus($('resultsStatus'), 'Enable location access to search near you.', true);
  requestLocation();
  return false;
}

function categoryOf(place) {
  return CATEGORY_BY_ID[place.category] || OTHER_CATEGORY;
}

function placeLabel(place) {
  return place.name || categoryOf(place).label.replace(/s$/, '');
}

async function api(path, options) {
  const response = await fetch(path, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('The server returned an unreadable response.');
  }
  if (!response.ok) throw new Error(data.error || 'The request failed.');
  return data;
}

/* ---------------------------- Opening hours ---------------------------- */

const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];

function openingStatus(hours) {
  if (!hours) return null;
  if (/24\s*\/\s*7/.test(hours)) return { open: true, label: 'Open 24 hours' };

  const now = new Date();
  const today = now.getDay();
  const minute = now.getHours() * 60 + now.getMinutes();
  const parts = hours.split(';').map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const match = part.match(/^([a-z]{2}(?:-[a-z]{2})?)\s+(.+)$/i);
    if (!match) continue;
    const [from, to] = match[1].toLowerCase().split('-');
    const startDay = WEEKDAYS.indexOf(from);
    const endDay = WEEKDAYS.indexOf(to || from);
    if (startDay < 0) continue;
    const inRange = to
      ? (today - startDay + 7) % 7 <= (endDay - startDay + 7) % 7
      : today === startDay;
    if (!inRange) continue;

    for (const timeMatch of match[2].matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)) {
      const openMinute = Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
      const closeMinute = Number(timeMatch[3]) * 60 + Number(timeMatch[4]);
      if (minute >= openMinute && minute < closeMinute) {
        return { open: true, label: `Open · closes ${timeMatch[3]}:${timeMatch[4]}` };
      }
      if (minute < openMinute) return { open: false, label: `Closed · opens ${timeMatch[1]}:${timeMatch[2]}` };
    }
  }
  return { open: false, label: 'Closed now' };
}

/* ------------------------------ Markers ------------------------------ */

function makePin(category, { selected = false, best = false } = {}) {
  const element = document.createElement('div');
  element.className = `pin${selected ? ' selected' : ''}${best ? ' best' : ''}`;
  element.style.setProperty('--pin-color', category.color);
  element.innerHTML = `<span>${category.icon}</span>`;
  return element;
}

function clearPlaceMarkers() {
  for (const marker of placeMarkers.values()) marker.remove();
  placeMarkers.clear();
}

function addPlaceMarkers() {
  clearPlaceMarkers();
  for (const place of state.places.slice(0, 60)) {
    const category = categoryOf(place);
    const element = makePin(category);
    element.title = placeLabel(place);
    const marker = new maplibregl.Marker({ element, anchor: 'bottom' })
      .setLngLat([place.lon, place.lat])
      .addTo(map);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      selectPlace(place);
    });
    placeMarkers.set(place.id, marker);
  }
  updateMarkerStates();
}

function updateMarkerStates() {
  const best = bestPlace();
  for (const place of state.places) {
    const marker = placeMarkers.get(place.id);
    if (!marker) continue;
    marker.getElement().classList.toggle('selected', place.id === state.selectedId);
    marker.getElement().classList.toggle('best', !!best && place.id === best.id);
  }
}

function bestPlace() {
  const routed = state.places.filter((place) => place.route);
  if (!routed.length) return null;
  return routed.reduce((best, place) => place.route.distanceKm < best.route.distanceKm ? place : best);
}

function updateUserMarker(position) {
  if (!position) return;
  if (!userMarker) {
    const element = document.createElement('div');
    element.className = 'user-dot';
    element.title = 'Start point';
    userMarker = new maplibregl.Marker({ element })
      .setLngLat([position.lon, position.lat])
      .addTo(map);
  } else {
    userMarker.setLngLat([position.lon, position.lat]);
  }
}

/* ------------------------------- Views ------------------------------- */

function switchView(view) {
  $('panel').hidden = false;
  document.body.classList.add('sheet-open');
  for (const name of ['results', 'place', 'directions']) {
    $(`${name}View`).hidden = name !== view;
  }
  setMapPadding();
}

function closePanel() {
  $('panel').hidden = true;
  document.body.classList.remove('sheet-open');
  setMapPadding();
}

function showResultsView() {
  switchView('results');
}

/* ------------------------------- Search ------------------------------- */

function renderChips() {
  $('categoryChips').innerHTML = CATEGORIES.map((category) => `
    <button class="chip" type="button" data-category="${category.id}">
      <span class="chip-icon">${category.icon}</span>${escapeHtml(category.label)}
    </button>
  `).join('');
}

function updateChipState() {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.category === state.activeCategory);
  });
}

function renderWelcome() {
  $('resultsTitle').textContent = 'Where to?';
  $('resultsSubtitle').textContent = state.origin
    ? `Ready to search around ${state.centerLabel}`
    : 'Allow location access to find places around you';
  setInlineStatus($('resultsStatus'), 'Find the nearest gas station, park, pharmacy, fountain — or almost anything mapped in OpenStreetMap.');
  $('locationGate').hidden = !!state.origin;
  const popular = ['fuel', 'park', 'restaurant', 'grocery', 'pharmacy', 'fountain'];
  $('resultList').innerHTML = `
    <div class="empty-state"><strong>Search for anything nearby</strong>Choose a shortcut below to find — and route to — the closest match.</div>
    ${popular.map((id) => {
      const category = CATEGORY_BY_ID[id];
      return `<button class="result-card" type="button" data-category="${id}">
        <span class="result-icon">${category.icon}</span>
        <span class="result-main"><span class="result-name">${escapeHtml(category.label)}</span>
        <span class="result-meta">Find the nearest one and see the route</span></span>
        <span class="result-distance">›</span>
      </button>`;
    }).join('')}
  `;
  $('resultsFooter').textContent = `Search radius ${state.radius / 1000} km · Powered by OpenStreetMap`;
}

function setInlineStatus(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function renderResults() {
  const title = state.activeCategory
    ? CATEGORY_BY_ID[state.activeCategory].label
    : `Results for “${state.lastQuery}”`;
  $('resultsTitle').textContent = title;
  $('resultsSubtitle').textContent = `${state.places.length} places within ${state.radius / 1000} km · ${state.centerLabel}`;

  if (!state.places.length) {
    setInlineStatus($('resultsStatus'), `Nothing mapped nearby. Try a wider radius or a different search.`);
    $('resultList').innerHTML = '<div class="empty-state"><strong>No matches found</strong>Try increasing the search radius or searching for something else.</div>';
    $('resultsFooter').textContent = 'Map data © OpenStreetMap contributors';
    return;
  }

  setInlineStatus($('resultsStatus'), 'Sorted by distance from your start point. Select a place to get directions.');
  $('resultList').innerHTML = state.places.map((place) => {
    const category = categoryOf(place);
    const hours = openingStatus(place.hours);
    const routePart = place.route
      ? `<span class="result-open">${formatDuration(place.route.durationSeconds)} ${MODE_LABEL[state.mode]}</span>`
      : '';
    return `<button class="result-card${place.id === state.selectedId ? ' selected' : ''}" type="button" data-place="${escapeHtml(place.id)}">
      <span class="result-icon" style="background:${category.color}22">${category.icon}</span>
      <span class="result-main">
        <span class="result-name">${escapeHtml(placeLabel(place))}</span>
        <span class="result-meta">${escapeHtml([place.brand, place.address].filter(Boolean).join(' · ') || category.label)}</span>
        ${hours ? `<span class="${hours.open ? 'result-open' : 'result-closed'}">${escapeHtml(hours.label)}</span>` : routePart}
      </span>
      <span class="result-distance">${formatDistance(place.route ? place.route.distanceKm * 1000 : place.distanceMeters)}</span>
    </button>`;
  }).join('');
  $('resultsFooter').textContent = 'Map data © OpenStreetMap contributors · Routes by Valhalla';
}

async function annotateNearest() {
  const candidates = state.places.slice(0, 3);
  if (!candidates.length) return;

  const requests = candidates.map(async (place) => {
    try {
      const route = await api('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { lat: state.origin.lat, lon: state.origin.lon },
          to: { lat: place.lat, lon: place.lon },
          mode: state.mode
        })
      });
      place.route = route;
    } catch {
      place.route = null;
    }
  });
  await Promise.all(requests);

  state.places.sort((a, b) => {
    if (a.route && b.route) return a.route.distanceKm - b.route.distanceKm;
    if (a.route) return -1;
    if (b.route) return 1;
    return a.distanceMeters - b.distanceMeters;
  });
  updateMarkerStates();
  renderResults();
}

async function performSearch({ categoryId = null, text = '', center = null } = {}) {
  if (!requireLocation()) return;
  const searchCenter = center || {
    lat: map.getCenter().lat,
    lon: map.getCenter().lng
  };

  state.activeCategory = categoryId;
  state.lastQuery = text;
  state.center = searchCenter;
  state.lastSearchCenter = { ...searchCenter };
  state.hasSearched = true;
  state.selectedId = null;
  state.places = [];
  state.route = null;
  clearPlaceMarkers();
  drawRoute([]);
  clearRouteEndpoints();
  stopNavigation();
  updateChipState();
  $('searchThisArea').hidden = true;
  $('locationGate').hidden = true;
  switchView('results');
  setInlineStatus($('resultsStatus'), 'Searching OpenStreetMap…');

  const sequence = ++searchSequence;
  try {
    const data = await api('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: searchCenter.lat,
        lon: searchCenter.lon,
        radius: state.radius,
        categoryId,
        text
      })
    });
    if (sequence !== searchSequence) return;

    state.places = data.places;
    state.centerLabel = center ? 'this area' : state.centerLabel;
    addPlaceMarkers();
    renderResults();

    if (!state.places.length) {
      $('resultsFooter').textContent = `No results from ${data.source}. Search radius ${state.radius / 1000} km.`;
      toast('No matches found nearby. Try a larger radius.');
      return;
    }

    const points = state.places.slice(0, 8).map((place) => [place.lon, place.lat]);
    map.fitBounds([[Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))],
      [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))]], {
      padding: cameraPadding(),
      maxZoom: 16.5,
      duration: 900
    });

    setInlineStatus($('resultsStatus'), `Found ${state.places.length} matches. Comparing routes to the closest ones…`);
    await annotateNearest();
    if (sequence !== searchSequence) return;
    const best = bestPlace();
    if (best) {
      setInlineStatus($('resultsStatus'), `Closest by ${MODE_LABEL[state.mode]} route: ${placeLabel(best)} · ${formatDistance(best.route.distanceKm * 1000)}.`);
    } else {
      setInlineStatus($('resultsStatus'), 'Sorted by straight-line distance. Select a place for its exact route.');
    }
    $('resultsFooter').textContent = `Map data from ${data.source} · ${state.places.length} places found`;
  } catch (error) {
    if (sequence !== searchSequence) return;
    setInlineStatus($('resultsStatus'), error.message, true);
    $('resultList').innerHTML = '<div class="empty-state"><strong>Search failed</strong>Check your connection and try again.</div>';
    toast(error.message);
  }
}

/* --------------------------- Place details --------------------------- */

function selectPlace(place) {
  state.selectedId = place.id;
  updateMarkerStates();
  switchView('place');

  const category = categoryOf(place);
  $('placeIcon').textContent = category.icon;
  $('placeName').textContent = placeLabel(place);
  $('placeCategory').textContent = category.label;

  const hours = openingStatus(place.hours);
  const info = [];
  if (place.address) info.push(['📍', escapeHtml(place.address)]);
  if (hours) info.push(['🕒', `<span class="${hours.open ? 'result-open' : 'result-closed'}">${escapeHtml(hours.label)}</span>${place.hours ? `<br><span style="color:#80868b">${escapeHtml(place.hours)}</span>` : ''}`]);
  if (place.phone) info.push(['📞', `<a href="tel:${escapeHtml(place.phone)}">${escapeHtml(place.phone)}</a>`]);
  if (place.website) {
    const safeUrl = /^https?:\/\//i.test(place.website) ? place.website : `https://${place.website}`;
    info.push(['🌐', `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(place.website)}</a>`]);
  }
  if (place.details) info.push(['ℹ️', escapeHtml(place.details)]);
  info.push(['📏', `${formatDistance(place.distanceMeters)} from your start point${place.route ? ` · ${formatDuration(place.route.durationSeconds)} ${MODE_LABEL[state.mode]}` : ''}`]);
  info.push(['🧭', `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`]);
  $('placeInfo').innerHTML = info.map(([icon, text]) => `
    <div class="info-row"><span class="info-icon">${icon}</span><span>${text}</span></div>
  `).join('');

  map.flyTo({ center: [place.lon, place.lat], zoom: 17.2, duration: 700 });
}

/* ---------------------------- Directions ---------------------------- */

function clearRouteEndpoints() {
  for (const marker of endpointMarkers) marker.remove();
  endpointMarkers = [];
}

function addEndpointMarkers() {
  clearRouteEndpoints();
  if (!state.route) return;
  endpointMarkers = [
    new maplibregl.Marker({ element: Object.assign(document.createElement('div'), {
      className: 'endpoint-marker start', textContent: 'A'
    }) }).setLngLat([state.origin.lon, state.origin.lat]).addTo(map),
    new maplibregl.Marker({ element: Object.assign(document.createElement('div'), {
      className: 'endpoint-marker end', textContent: 'B'
    }) }).setLngLat([state.destination.lon, state.destination.lat]).addTo(map)
  ];
}

function openDirections(place = null) {
  stopNavigation();
  switchView('directions');
  state.route = null;
  drawRoute([]);
  clearRouteEndpoints();
  $('routeResult').hidden = true;
  setInlineStatus($('routeStatus'), 'Choose a destination to see the best route.');
  $('originInput').value = state.origin?.label || '';

  if (place) {
    state.destination = { lat: place.lat, lon: place.lon, label: placeLabel(place) };
    $('destinationInput').value = placeLabel(place);
    setInlineStatus($('routeStatus'), `Ready to route to ${placeLabel(place)} by ${MODE_LABEL[state.mode]}.`);
  } else if (state.destination) {
    $('destinationInput').value = state.destination.label;
  }
  setTimeout(() => $('destinationInput').focus(), 150);
}

const TURN_ICONS = {
  0: '↑', 1: '↑', 2: '↰', 3: '↱', 4: '↑', 5: '🏁', 6: '↰', 7: '↱',
  8: '↑', 9: '↑', 10: '↖', 11: '↗', 12: '↰', 13: '↱', 14: '⤺', 15: '⤻',
  16: '↶', 17: '↷', 18: '↻', 19: '↻', 20: '↖', 21: '↗', 22: '⇠', 23: '⇢',
  24: '⇥', 25: '⇤', 26: '⤴', 27: '⤵', 28: '⤴', 29: '↰', 30: '↱'
};

function renderRoute(route) {
  state.route = route;
  $('routeResult').hidden = false;
  $('routeTime').textContent = formatDuration(route.durationSeconds);
  $('routeDistance').textContent = `${formatDistance(route.distanceKm * 1000)} · ${MODE_LABEL[state.mode]}`;
  $('routeCredit').textContent = 'Route and step-by-step directions by Valhalla, using open OpenStreetMap data.';
  $('stepList').innerHTML = route.maneuvers.length
    ? route.maneuvers.map((step, index) => `
      <div class="step">
        <span class="step-icon">${TURN_ICONS[step.type] || '↑'}</span>
        <span class="step-text">${index === 0 ? 'Start: ' : ''}${escapeHtml(step.instruction)}</span>
        <span class="step-distance">${step.distanceKm >= 1 ? `${step.distanceKm.toFixed(1)} km` : `${Math.round(step.distanceKm * 1000)} m`}</span>
      </div>
    `).join('')
    : '<div class="step"><span class="step-icon">↑</span><span class="step-text">Follow the highlighted route to your destination.</span></div>';

  drawRoute(route.coordinates);
  addEndpointMarkers();
  setInlineStatus($('routeStatus'), `Route ready · ${formatDistance(route.distanceKm * 1000)} · ${formatDuration(route.durationSeconds)}.`);

  const coords = route.coordinates;
  const lngs = coords.map((point) => point[1]);
  const lats = coords.map((point) => point[0]);
  map.fitBounds([
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)]
  ], {
    padding: cameraPadding(10),
    maxZoom: 16.5,
    duration: 900
  });
}

async function resolveInput(input, current) {
  const value = input.value.trim();
  if (!value) return null;
  if (current && (value === current.label || value.toLowerCase() === 'your location')) return current;

  const known = state.places.find((place) => placeLabel(place) === value);
  if (known) {
    return { lat: known.lat, lon: known.lon, label: placeLabel(known) };
  }

  try {
    const data = await api(`/api/geocode?q=${encodeURIComponent(value)}`);
    if (!data.results.length) return null;
    const result = data.results[0];
    const resolved = { lat: result.lat, lon: result.lon, label: result.label.split(',').slice(0, 2).join(',') };
    input.value = resolved.label;
    return resolved;
  } catch (error) {
    toast(error.message);
    return null;
  }
}

async function getRoute() {
  if (state.nav) stopNavigation();

  const origin = await resolveInput($('originInput'), state.origin);
  const destination = await resolveInput($('destinationInput'), state.destination);
  if (origin) state.origin = origin;
  if (destination) state.destination = destination;
  updateUserMarker(state.origin);

  if (!state.origin) {
    requireLocation();
    return;
  }
  if (!state.destination) {
    setInlineStatus($('routeStatus'), 'Enter a destination or select a place on the map first.', true);
    toast('Choose a destination first.');
    return;
  }

  const button = $('getRoute');
  button.disabled = true;
  button.textContent = 'Finding the best route…';
  setInlineStatus($('routeStatus'), `Calculating a ${MODE_LABEL[state.mode]} route…`);

  try {
    const route = await api('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: { lat: state.origin.lat, lon: state.origin.lon },
        to: { lat: state.destination.lat, lon: state.destination.lon },
        mode: state.mode
      })
    });
    renderRoute(route);
  } catch (error) {
    $('routeResult').hidden = true;
    setInlineStatus($('routeStatus'), error.message, true);
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Get directions';
  }
}

/* -------------------------- Navigation demo -------------------------- */

function cumulativeDistances(coordinates) {
  const distances = [0];
  for (let index = 1; index < coordinates.length; index++) {
    const a = { lat: coordinates[index - 1][0], lon: coordinates[index - 1][1] };
    const b = { lat: coordinates[index][0], lon: coordinates[index][1] };
    distances.push(distances[index - 1] + haversine(a, b));
  }
  return distances;
}

function positionAlong(coordinates, distances, traveled) {
  let index = 1;
  while (index < distances.length - 1 && distances[index] < traveled) index++;
  const start = distances[index - 1];
  const span = distances[index] - start || 1;
  const fraction = Math.max(0, Math.min(1, (traveled - start) / span));
  const from = coordinates[index - 1];
  const to = coordinates[index];
  return {
    lat: from[0] + (to[0] - from[0]) * fraction,
    lon: from[1] + (to[1] - from[1]) * fraction,
    index
  };
}

function stopNavigation() {
  if (state.nav?.frame) cancelAnimationFrame(state.nav.frame);
  state.nav = null;
  $('navBanner').hidden = true;
  if (navMarker) {
    navMarker.remove();
    navMarker = null;
  }
  map.jumpTo({ pitch: 0, bearing: 0 });
  document.body.classList.remove('navigating');
  setMapPadding();
}

function startNavigation() {
  if (!state.route || state.nav) return;

  const element = document.createElement('div');
  element.className = 'nav-marker';
  navMarker = new maplibregl.Marker({ element })
    .setLngLat([state.route.coordinates[0][1], state.route.coordinates[0][0]])
    .addTo(map);

  const distances = cumulativeDistances(state.route.coordinates);
  state.nav = {
    distances,
    total: distances[distances.length - 1],
    traveled: 0,
    lastTime: performance.now(),
    frame: null,
    finished: false
  };
  $('navBanner').hidden = false;
  document.body.classList.add('navigating');
  setMapPadding();
  $('navSubtext').textContent = `Navigating by ${MODE_LABEL[state.mode]} · 25× accelerated preview`;
  map.easeTo({ zoom: 17.4, pitch: 45, duration: 1000 });
  toast('Navigation started. The blue dot follows the route at 25× speed.');
  state.nav.frame = requestAnimationFrame(navigationTick);
}

function navigationTick(time) {
  const nav = state.nav;
  if (!nav) return;

  const delta = Math.min((time - nav.lastTime) / 1000, 0.2);
  nav.lastTime = time;
  nav.traveled = Math.min(nav.total, nav.traveled + MODE_SPEED[state.mode] * 25 * delta);

  const position = positionAlong(state.route.coordinates, nav.distances, nav.traveled);
  navMarker.setLngLat([position.lon, position.lat]);
  const direction = bearing(
    { lat: state.route.coordinates[Math.max(0, position.index - 1)][0], lon: state.route.coordinates[Math.max(0, position.index - 1)][1] },
    { lat: state.route.coordinates[Math.min(state.route.coordinates.length - 1, position.index)][0], lon: state.route.coordinates[Math.min(state.route.coordinates.length - 1, position.index)][1] }
  );
  map.jumpTo({ center: [position.lon, position.lat], bearing: direction });

  const progress = nav.total ? nav.traveled / nav.total : 1;
  const step = [...state.route.maneuvers].reverse().find((item) => item.shapeIndex <= position.index) || state.route.maneuvers[0];
  if (step) {
    $('navInstruction').textContent = nav.traveled >= nav.total ? 'You have arrived' : step.instruction;
    $('navArrow').textContent = nav.traveled >= nav.total ? '🏁' : (TURN_ICONS[step.type] || '↑');
  }
  const remainingKm = state.route.distanceKm * (1 - progress);
  $('navSubtext').textContent = `${state.destination?.label || 'Destination'} · ${remainingKm < 1 ? `${Math.round(remainingKm * 1000)} m` : `${remainingKm.toFixed(1)} km`} left`;
  $('navRemaining').textContent = `Remaining: ${formatDuration(state.route.durationSeconds * (1 - progress))}`;
  const eta = new Date(Date.now() + state.route.durationSeconds * (1 - progress) * 1000);
  $('navEta').textContent = `ETA ${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  $('navProgressFill').style.width = `${Math.round(progress * 100)}%`;

  if (nav.traveled >= nav.total) {
    toast('You have arrived at your destination.');
    nav.finished = true;
    stopNavigation();
    return;
  }
  nav.frame = requestAnimationFrame(navigationTick);
}

/* ------------------------------- Events ------------------------------- */

$('categoryChips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-category]');
  if (!chip) return;
  const category = CATEGORY_BY_ID[chip.dataset.category];
  $('searchInput').value = category.label;
  performSearch({ categoryId: category.id });
});

$('resultList').addEventListener('click', (event) => {
  const placeButton = event.target.closest('[data-place]');
  if (placeButton) {
    const place = state.places.find((item) => item.id === placeButton.dataset.place);
    if (place) selectPlace(place);
    return;
  }
  const categoryButton = event.target.closest('[data-category]');
  if (categoryButton) {
    const category = CATEGORY_BY_ID[categoryButton.dataset.category];
    $('searchInput').value = category.label;
    performSearch({ categoryId: category.id });
  }
});

$('searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('searchInput').value.trim();
  if (!text) {
    toast('Type what you are looking for, or pick a category.');
    return;
  }
  const category = interpretQuery(text);
  if (category) performSearch({ categoryId: category.id, text });
  else performSearch({ text });
});

$('searchInput').addEventListener('input', () => {
  $('clearSearch').hidden = !$('searchInput').value;
});
$('clearSearch').addEventListener('click', () => {
  $('searchInput').value = '';
  $('clearSearch').hidden = true;
  $('searchInput').focus();
});

$('openDirections').addEventListener('click', () => openDirections());
$('placeDirections').addEventListener('click', () => {
  const place = state.places.find((item) => item.id === state.selectedId);
  openDirections(place);
});

$('copyLink').addEventListener('click', async () => {
  const place = state.places.find((item) => item.id === state.selectedId);
  if (!place) return;
  const url = `${location.origin}${location.pathname}?place=${place.lat.toFixed(6)},${place.lon.toFixed(6)}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Link to this place copied.');
  } catch {
    toast(url);
  }
});

document.querySelectorAll('[data-close-panel]').forEach((button) => {
  button.addEventListener('click', closePanel);
});

$('radiusBtn').addEventListener('click', () => { $('radiusMenu').hidden = !$('radiusMenu').hidden; });
$('radiusMenu').addEventListener('click', (event) => {
  const button = event.target.closest('[data-radius]');
  if (!button) return;
  state.radius = Number(button.dataset.radius);
  $('radiusBtn').textContent = `${state.radius / 1000} km`;
  $('radiusMenu').hidden = true;
  renderWelcomeFooter();
  if (state.hasSearched) performSearch({
    categoryId: state.activeCategory,
    text: state.lastQuery,
    center: state.lastSearchCenter
  });
});
function renderWelcomeFooter() {
  $('resultsFooter').textContent = `Search radius ${state.radius / 1000} km · Powered by OpenStreetMap`;
}

$('modeTabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (!button) return;
  state.mode = button.dataset.mode;
  document.querySelectorAll('#modeTabs button').forEach((tab) => tab.classList.toggle('active', tab === button));
  for (const place of state.places) place.route = null;
  updateMarkerStates();
  if (!$('resultsView').hidden) renderResults();
  if (state.route) getRoute();
});

$('getRoute').addEventListener('click', getRoute);
$('destinationInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') getRoute();
});
$('originInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') getRoute();
});
$('swapPlaces').addEventListener('click', () => {
  if (!state.origin || !state.destination) {
    toast('Choose a start and a destination first.');
    return;
  }
  const origin = $('originInput').value;
  $('originInput').value = $('destinationInput').value;
  $('destinationInput').value = origin;
  [state.origin, state.destination] = [state.destination, state.origin];
  updateUserMarker(state.origin);
  if (state.destination) {
    map.flyTo({ center: [state.destination.lon, state.destination.lat], zoom: 15, duration: 600 });
  }
});

$('startNavigation').addEventListener('click', startNavigation);
$('exitNavigation').addEventListener('click', stopNavigation);

$('zoomIn').addEventListener('click', () => map.zoomIn());
$('zoomOut').addEventListener('click', () => map.zoomOut());
$('compassBtn').addEventListener('click', () => map.easeTo({ bearing: 0, pitch: 0, duration: 500 }));
$('locateBtn').addEventListener('click', () => requestLocation());
$('retryLocation').addEventListener('click', () => requestLocation());

$('panelHandle').addEventListener('click', () => {
  const expanded = $('panel').classList.toggle('expanded');
  document.body.classList.toggle('panel-expanded', expanded);
  setMapPadding();
});

$('panel').addEventListener('transitionend', () => {
  updateSheetInset();
  setMapPadding();
});
window.addEventListener('resize', () => {
  updateSheetInset();
  setMapPadding();
});

$('layersBtn').addEventListener('click', () => { $('layersMenu').hidden = !$('layersMenu').hidden; });
$('layersMenu').addEventListener('click', (event) => {
  const button = event.target.closest('[data-style]');
  if (!button) return;
  state.styleId = button.dataset.style;
  map.setStyle(STYLES[state.styleId]);
  document.querySelectorAll('#layersMenu button').forEach((item) => item.classList.toggle('selected', item === button));
  $('layersMenu').hidden = true;
});

$('searchThisArea').addEventListener('click', () => {
  performSearch({
    categoryId: state.activeCategory,
    text: state.lastQuery,
    center: { lat: map.getCenter().lat, lon: map.getCenter().lng }
  });
});

map.on('moveend', () => {
  if (!state.hasSearched || state.nav) return;
  const center = { lat: map.getCenter().lat, lon: map.getCenter().lng };
  $('searchThisArea').hidden = haversine(center, state.lastSearchCenter) < 500;
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.nav) stopNavigation();
  else if (!$('panel').hidden) closePanel();
  $('radiusMenu').hidden = true;
  $('layersMenu').hidden = true;
});

/* ------------------------------- Startup ------------------------------- */

renderChips();
renderWelcome();
setMapPadding();
requestLocation();

const shared = new URLSearchParams(location.search).get('place');
if (shared) {
  const [lat, lon] = shared.split(',').map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    state.destination = { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
    map.flyTo({ center: [lon, lat], zoom: 16 });
  }
}
