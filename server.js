import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, CATEGORY_BY_ID, OTHER_CATEGORY, categoryForTags, interpretQuery } from './categories.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const OVERPASS_ENDPOINTS = [
  'https://api.overpass-turbo.eu/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'nearby-finder-demo/1.0 (local map app; contact: demo@example.com)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cached(key, producer) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.value;
  const value = producer();
  cache.set(key, { time: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validCoord(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

async function postWithTimeout(url, body, headers, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'follow'
    });
  } finally {
    clearTimeout(timer);
  }
}

function buildOverpassQuery({ lat, lon, radius, categoryId, text }) {
  const around = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  let selectors;

  if (categoryId && CATEGORY_BY_ID[categoryId]) {
    selectors = CATEGORY_BY_ID[categoryId].filters.flatMap((filter) => {
      const [key, value] = filter.split('=');
      return `nwr["${key}"="${value}"]${around};`;
    });
  } else if (text) {
    const pattern = escapeRegex(text);
    selectors = [
      `nwr["name"~"${pattern}",i]${around};`,
      `nwr["amenity"~"${pattern}",i]${around};`,
      `nwr["shop"~"${pattern}",i]${around};`,
      `nwr["leisure"~"${pattern}",i]${around};`,
      `nwr["tourism"~"${pattern}",i]${around};`
    ];
  } else {
    return null;
  }

  return `[out:json][timeout:25];\n(\n${selectors.join('\n')}\n);\nout center tags;`;
}

function normalizePlaces(elements, lat, lon) {
  const seen = new Set();
  const places = [];

  for (const element of elements || []) {
    const placeLat = element.lat ?? element.center?.lat;
    const placeLon = element.lon ?? element.center?.lon;
    if (!Number.isFinite(placeLat) || !Number.isFinite(placeLon)) continue;

    const id = `${element.type || 'n'}-${element.id}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const tags = element.tags || {};
    const category = categoryForTags(tags);
    places.push({
      id,
      lat: placeLat,
      lon: placeLon,
      category: category.id,
      distanceMeters: Math.round(haversineMeters(lat, lon, placeLat, placeLon)),
      name: tags['name:en'] || tags.name || '',
      brand: tags.brand || tags.operator || '',
      address: [
        tags['addr:housenumber'],
        tags['addr:street'],
        tags['addr:city'],
        tags['addr:postcode']
      ].filter(Boolean).join(' '),
      hours: tags.opening_hours || '',
      phone: tags['contact:phone'] || tags.phone || '',
      website: tags['contact:website'] || tags.website || '',
      details: [
        tags.cuisine && `Cuisine: ${tags.cuisine.replaceAll('_', ' ')}`,
        tags.fee === 'no' && 'Free entry',
        tags.fee === 'yes' && 'Fee may apply',
        tags.access && `Access: ${tags.access}`,
        tags.description
      ].filter(Boolean).join(' · '),
      tags
    });
  }

  places.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return places.slice(0, 80);
}

async function handleSearch(request, response) {
  let body;
  try {
    body = await readJson(request);
  } catch {
    return json(response, 400, { error: 'Invalid JSON body.' });
  }

  const { lat, lon } = body;
  if (!validCoord(lat) || !validCoord(lon)) {
    return json(response, 400, { error: 'A valid latitude and longitude are required.' });
  }

  const radius = Math.min(15000, Math.max(300, Number(body.radius) || 5000));
  let categoryId = String(body.categoryId || '');
  let text = String(body.text || '').trim().slice(0, 120);

  if (text && !categoryId) {
    const interpreted = interpretQuery(text);
    if (interpreted) categoryId = interpreted.id;
  }
  if (categoryId && !CATEGORY_BY_ID[categoryId]) categoryId = '';

  const query = buildOverpassQuery({ lat, lon, radius, categoryId, text });
  if (!query) return json(response, 400, { error: 'Tell me what to look for.' });

  const cacheKey = `search:${query}`;
  try {
    const result = await cached(cacheKey, async () => {
      const failures = [];
      for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
          const apiResponse = await postWithTimeout(
            endpoint,
            new URLSearchParams({ data: query }).toString(),
            {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'Accept': 'application/json',
              'User-Agent': USER_AGENT
            },
            20000
          );
          const raw = await apiResponse.text();
          if (!apiResponse.ok) throw new Error(`HTTP ${apiResponse.status}: ${raw.slice(0, 120)}`);
          const data = JSON.parse(raw);
          if (!Array.isArray(data.elements)) throw new Error('No elements in Overpass response.');
          return { endpoint, elements: data.elements };
        } catch (error) {
          failures.push(`${new URL(endpoint).hostname}: ${error.message}`);
        }
      }
      throw new Error(`All Overpass servers failed. ${failures.join(' | ')}`);
    });

    const places = normalizePlaces(result.elements, lat, lon);
    json(response, 200, {
      places,
      source: new URL(result.endpoint).hostname,
      category: CATEGORY_BY_ID[categoryId] || OTHER_CATEGORY,
      radius
    });
  } catch (error) {
    console.error('[search]', error.message);
    json(response, 502, { error: 'The map data service is unavailable right now. Please try again.' });
  }
}

const MODE_COSTING = { drive: 'auto', walk: 'pedestrian', bike: 'bicycle' };

function decodePolyline6(encoded) {
  let index = 0;
  let lat = 0;
  let lon = 0;
  const points = [];

  function readValue() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= encoded.length) throw new Error('Invalid route shape.');
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return (result & 1) ? ~(result >> 1) : (result >> 1);
  }

  while (index < encoded.length) {
    lat += readValue();
    lon += readValue();
    points.push([lat / 1e6, lon / 1e6]);
  }
  return points;
}

async function handleRoute(request, response) {
  let body;
  try {
    body = await readJson(request);
  } catch {
    return json(response, 400, { error: 'Invalid JSON body.' });
  }

  const { from, to, mode = 'walk' } = body;
  if (!from || !to || !validCoord(from.lat) || !validCoord(from.lon) ||
      !validCoord(to.lat) || !validCoord(to.lon) || !MODE_COSTING[mode]) {
    return json(response, 400, { error: 'Valid start, destination and travel mode are required.' });
  }

  const payload = {
    locations: [
      { lat: from.lat, lon: from.lon },
      { lat: to.lat, lon: to.lon }
    ],
    costing: MODE_COSTING[mode],
    units: 'kilometers',
    language: 'en-US',
    directions_type: 'instructions'
  };
  const cacheKey = `route:${JSON.stringify(payload)}`;

  try {
    const route = await cached(cacheKey, async () => {
      const apiResponse = await postWithTimeout(
        VALHALLA_URL,
        JSON.stringify(payload),
        { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': USER_AGENT },
        35000
      );
      const raw = await apiResponse.text();
      if (!apiResponse.ok) throw new Error(`Valhalla HTTP ${apiResponse.status}: ${raw.slice(0, 120)}`);
      const data = JSON.parse(raw);
      if (data.trip?.status !== 0 || !data.trip.summary || !data.trip.legs?.[0]?.shape) {
        throw new Error(data.trip?.status_message || 'No usable route returned.');
      }

      const distanceKm = Number(data.trip.summary.length);
      const durationSeconds = Number(data.trip.summary.time);
      const shape = data.trip.legs[0].shape;
      const coordinates = shape.includes('(') ? parseEncodedPolyline(shape) : decodePolyline6(shape);
      if (!Number.isFinite(distanceKm) || distanceKm <= 0 ||
          !Number.isFinite(durationSeconds) || durationSeconds < 0 || coordinates.length < 2) {
        throw new Error('Route response was invalid.');
      }

      const maneuvers = (data.trip.legs[0].maneuvers || []).map((item) => ({
        instruction: item.instruction || 'Continue on the route',
        distanceKm: Number(item.length) || 0,
        durationSeconds: Number(item.time) || 0,
        shapeIndex: Number(item.begin_shape_index) || 0,
        type: Number(item.type) || 0
      }));

      return { distanceKm, durationSeconds, coordinates, maneuvers };
    });

    json(response, 200, route);
  } catch (error) {
    console.error('[route]', error.message);
    json(response, 502, { error: 'No route could be calculated right now. Try another destination or mode.' });
  }
}

// Valhalla occasionally wraps the encoded shape in "polyline6(...)".
function parseEncodedPolyline(shape) {
  const match = shape.match(/polyline6\((.+)\)/);
  return decodePolyline6(match ? match[1] : shape.replace(/[()]/g, ''));
}

async function handleGeocode(request, response, url) {
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
  if (q.length < 3) return json(response, 200, { results: [] });

  // Accept pasted "lat, lon" coordinates as well as place names.
  const coordinateMatch = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (coordinateMatch) {
    const lat = Number(coordinateMatch[1]);
    const lon = Number(coordinateMatch[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return json(response, 200, {
        results: [{ label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon }]
      });
    }
  }

  try {
    const results = await cached(`geocode:${q.toLowerCase()}`, async () => {
      const fetchJson = async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const apiResponse = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
            signal: controller.signal
          });
          if (!apiResponse.ok) throw new Error(`HTTP ${apiResponse.status}`);
          return await apiResponse.json();
        } finally {
          clearTimeout(timer);
        }
      };

      // Photon is the primary geocoder; Nominatim is a fallback where allowed.
      try {
        const target = new URL(PHOTON_URL);
        target.searchParams.set('q', q);
        target.searchParams.set('limit', '5');
        const data = await fetchJson(target);
        const results = (data.features || []).map((feature) => {
          const props = feature.properties || {};
          const [lon, lat] = feature.geometry?.coordinates || [];
          return {
            label: [props.name, props.city || props.town || props.county, props.state, props.country]
              .filter(Boolean).join(', '),
            lat: Number(lat),
            lon: Number(lon)
          };
        }).filter((item) => item.label && validCoord(item.lat) && validCoord(item.lon));
        if (results.length) return results;
      } catch (error) {
        console.warn('[geocode] Photon failed:', error.message);
      }

      const target = new URL(NOMINATIM_URL);
      target.searchParams.set('q', q);
      target.searchParams.set('format', 'jsonv2');
      target.searchParams.set('limit', '5');
      target.searchParams.set('addressdetails', '0');
      const data = await fetchJson(target);
      return (Array.isArray(data) ? data : []).map((item) => ({
        label: item.display_name,
        lat: Number(item.lat),
        lon: Number(item.lon)
      })).filter((item) => validCoord(item.lat) && validCoord(item.lon));
    });
    json(response, 200, { results });
  } catch (error) {
    console.error('[geocode]', error.message);
    json(response, 502, { error: 'Place lookup is unavailable right now.' });
  }
}

async function serveStatic(response, url) {
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relative);
  if (!filePath.startsWith(ROOT + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': path.extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    if (request.method === 'POST' && url.pathname === '/api/search') return await handleSearch(request, response);
    if (request.method === 'POST' && url.pathname === '/api/route') return await handleRoute(request, response);
    if (request.method === 'GET' && url.pathname === '/api/geocode') return await handleGeocode(request, response, url);
    if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true });
    if (request.method === 'GET') return await serveStatic(response, url);
    json(response, 405, { error: 'Method not allowed.' });
  } catch (error) {
    console.error('[server]', error);
    if (!response.headersSent) json(response, 500, { error: 'Unexpected server error.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nearby is running at http://localhost:${PORT}`);
  console.log(`Categories: ${CATEGORIES.length} · No npm dependencies required.`);
});
