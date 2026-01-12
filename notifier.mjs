/**
 * ADS-B takeoff/landing notifier -> Discord webhook
 *
 * SAFE USE: only track aircraft you own/operate or have permission to track.
 *
 * Data source:
 *   ADSBexchange via RapidAPI v2 endpoint:
 *     https://adsbexchange-com1.p.rapidapi.com/v2/icao/{icao}/
 *   Requires headers: x-rapidapi-host and x-rapidapi-key
 *
 * Env:
 *   RAPIDAPI_KEY             required (RapidAPI key)
 *   ICAO24                  required (6 hex chars, e.g. 444444)
 *   DISCORD_WEBHOOK_URL     required
 *   POLL_SECONDS            optional (default 15)
 *
 * Optional map image:
 *   MAPBOX_TOKEN            optional
 *   MAP_W                   optional (default 900)
 *   MAP_H                   optional (default 500)
 *
 * Heuristics:
 *   - "takeoff" when we see airborne (gnd=false) and speed/alt pass thresholds
 *   - "landing" when we see ground (gnd=true) and speed drops below threshold
 *
 * Why heuristics:
 *   Depending on source and aircraft, "gnd" can be flaky; speed/alt help.
 */

import "dotenv/config";
import fetch from "node-fetch";
import FormData from "form-data";
import { Readable } from "stream";
import http from "http";
import { URL } from "url";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
let ICAO24 = (process.env.ICAO24 || "").trim().toLowerCase();
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const API_PORT = Number(process.env.API_PORT || 3000);
const API_KEY = process.env.API_KEY || ""; // Optional API key for security

const POLL_SECONDS = Number(process.env.POLL_SECONDS || 300); // Default: 5 minutes (for airborne)
const GROUND_POLL_SECONDS = Number(process.env.GROUND_POLL_SECONDS || 900); // Default: 15 minutes (for on-ground)
const STATE_CHECK_INTERVAL_SECONDS = Number(process.env.STATE_CHECK_INTERVAL_SECONDS || 1800); // Default: 30 minutes
const UPDATE_INTERVAL_SECONDS = Number(process.env.UPDATE_INTERVAL_SECONDS || 300); // Default: 5 minutes (for position updates when airborne)

// Optional map image support (static)
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";
const MAP_W = Number(process.env.MAP_W || 900);
const MAP_H = Number(process.env.MAP_H || 500);

if (!RAPIDAPI_KEY) throw new Error("Missing RAPIDAPI_KEY");
if (!DISCORD_WEBHOOK_URL) throw new Error("Missing DISCORD_WEBHOOK_URL");

// Initialize ICAO24 if provided, but allow it to be set via API
let GLOBE_URL = ICAO24 ? `https://globe.adsbexchange.com/?icao=${ICAO24}` : "";

// Function to update ICAO24 and reset state
function updateICAO24(newIcao) {
  const trimmed = (newIcao || "").trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(trimmed)) {
    throw new Error("ICAO24 must be 6 hex chars (e.g. 4844e6)");
  }
  
  ICAO24 = trimmed;
  GLOBE_URL = `https://globe.adsbexchange.com/?icao=${ICAO24}`;
  
  // Reset state when changing aircraft
  currentState = STATE.UNKNOWN;
  firstCheckSent = false;
  lastKnownPosition = null;
  lastUpdateSent = 0;
  lastPositionGroundNotificationSent = 0;
  lastStateCheck = Date.now();
  lastPositionCheck = Date.now();
  positionMismatchMode = false;
  lastEvent = null;
  
  console.log(`[${nowIso()}] ICAO24 updated to: ${ICAO24}`);
  return ICAO24;
}

// --- thresholds (tune if needed) ---
const TAKEOFF_GS_MIN_KTS = 50; // speed threshold to confirm takeoff
const TAKEOFF_ALT_MIN_FT = 200; // altitude threshold to confirm takeoff
const LANDING_GS_MAX_KTS = 30; // speed threshold to confirm landing

function nowIso() {
  return new Date().toISOString();
}

function fmtTimeBoth(tsMs) {
  const d = new Date(tsMs);
  const utc = d.toISOString().replace("T", " ").replace("Z", " UTC");
  const local = d.toLocaleString();
  return { utc, local };
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

/**
 * Parse aircraft data from API response (handles various formats)
 */
function parseAircraftData(data) {
  // RapidAPI v2 endpoint may return single object or array
  // Handle both cases
  let a = null;
  if (data?.ac && Array.isArray(data.ac)) {
    // Array response
    a = data.ac.find((x) => String(x?.hex || x?.icao || x?.icao24 || "").toLowerCase() === ICAO24) || data.ac[0];
  } else if (data?.ac && !Array.isArray(data.ac)) {
    // Single object response
    a = data.ac;
  } else if (Array.isArray(data)) {
    // Direct array
    a = data.find((x) => String(x?.hex || x?.icao || x?.icao24 || "").toLowerCase() === ICAO24) || data[0];
  } else if (data?.hex || data?.icao || data?.icao24) {
    // Direct object
    a = data;
  }

  if (!a) return null;

  // Normalize common ADSBexchange-style fields (v2 docs list 'hex' etc.)
  // Check for position in root first, then in lastPosition object
  let latRaw = pick(a, ["lat", "latitude"]);
  let lonRaw = pick(a, ["lon", "longitude"]);
  let lat = latRaw != null ? Number(latRaw) : NaN;
  let lon = lonRaw != null ? Number(lonRaw) : NaN;
  
  // If not found in root, check lastPosition object (for on-ground aircraft)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const lastPos = a.lastPosition || a.last_position || a.lastPos;
    if (lastPos) {
      // Try direct access first
      if (lastPos.lat != null) lat = Number(lastPos.lat);
      if (lastPos.lon != null) lon = Number(lastPos.lon);
      
      // If still not found, try latitude/longitude or use pick
      if (!Number.isFinite(lat)) {
        const latAlt = lastPos.latitude ?? pick(lastPos, ["lat", "latitude"]);
        if (latAlt != null) lat = Number(latAlt);
      }
      if (!Number.isFinite(lon)) {
        const lonAlt = lastPos.longitude ?? pick(lastPos, ["lon", "longitude"]);
        if (lonAlt != null) lon = Number(lonAlt);
      }
    }
  }
  
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const gnd = pick(a, ["gnd", "on_ground"]);
  const altBaro = pick(a, ["alt_baro", "altitude_baro"]);
  // Check if alt_baro is "ground" (string) - this indicates aircraft is on ground
  const isGroundFromAlt = typeof altBaro === "string" && altBaro.toLowerCase() === "ground";
  const isGround = typeof gnd === "boolean" ? gnd : (gnd === 1 || gnd === "1" ? true : (gnd === 0 || gnd === "0" ? false : (isGroundFromAlt ? true : null)));

  const gs = Number(pick(a, ["gs", "spd", "speed"])); // often knots
  // Handle alt_baro which can be "ground" (string) or a number
  const altBaroRaw = pick(a, ["alt_baro", "alt_geom", "altitude", "alt"]);
  let alt = null;
  if (altBaroRaw != null) {
    if (typeof altBaroRaw === "string" && altBaroRaw.toLowerCase() === "ground") {
      alt = "ground";
    } else {
      const altNum = Number(altBaroRaw);
      if (Number.isFinite(altNum)) {
        alt = altNum;
      }
    }
  }

  const callsign = String(pick(a, ["flight", "callsign"]) || "").trim();
  const track = pick(a, ["trk", "track", "heading"]);
  const seen = pick(a, ["seen", "seen_pos", "last_contact"]);

  return {
    lat,
    lon,
    isGround, // true/false/null
    gs: Number.isFinite(gs) ? gs : null,
    alt: alt, // Can be number (feet) or "ground" (string)
    callsign: callsign || null,
    track: track != null ? Number(track) : null,
    seen: seen != null ? Number(seen) : null,
    raw: a,
  };
}

/**
 * Fetch aircraft LAST position from /v2/hex/{icao}/ endpoint
 */
async function fetchLastPosition() {
  const url = `https://adsbexchange-com1.p.rapidapi.com/v2/hex/${ICAO24}/`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-rapidapi-host": "adsbexchange-com1.p.rapidapi.com",
      "x-rapidapi-key": RAPIDAPI_KEY,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ADSBx Last Position HTTP ${res.status} ${res.statusText}: ${txt}`);
  }

  const data = await res.json();
  return parseAircraftData(data);
}

/**
 * Fetch aircraft LIVE position from /v2/icao/{icao}/ endpoint
 */
async function fetchLivePosition() {
  const url = `https://adsbexchange-com1.p.rapidapi.com/v2/icao/${ICAO24}/`;

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "x-rapidapi-host": "adsbexchange-com1.p.rapidapi.com",
      "x-rapidapi-key": RAPIDAPI_KEY,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ADSBx Live Position HTTP ${res.status} ${res.statusText}: ${txt}`);
  }

  const data = await res.json();
  return parseAircraftData(data);
}

/**
 * Fetch both last and live positions, compare them, and return the best snapshot
 * Returns { live, last, positionsMatch, isActive } where:
 *   - live: current live position data
 *   - last: last known position data
 *   - positionsMatch: true if positions are the same (within threshold)
 *   - isActive: true if aircraft appears to be actively transmitting
 */
async function fetchAircraftSnapshot() {
  const [live, last] = await Promise.all([
    fetchLivePosition().catch(() => null),
    fetchLastPosition().catch(() => null),
  ]);

  // If we have no data at all, return null
  if (!live && !last) return null;

  // Prefer live position if available, otherwise use last
  const snapshot = live || last;

  // Check if positions match (within ~0.01 degrees, roughly 1km)
  const POSITION_THRESHOLD = 0.01;
  let positionsMatch = false;
  if (live && last) {
    const latDiff = Math.abs(live.lat - last.lat);
    const lonDiff = Math.abs(live.lon - last.lon);
    positionsMatch = latDiff < POSITION_THRESHOLD && lonDiff < POSITION_THRESHOLD;
  }

  // Aircraft is active if live position exists and differs from last (or last doesn't exist)
  const isActive = live !== null && (!last || !positionsMatch);

  return {
    ...snapshot,
    live,
    last,
    positionsMatch,
    isActive,
  };
}

/**
 * Optional: build a simple static map image URL (centered on last point).
 * This avoids scraping Globe.
 * Mapbox static images docs: https://docs.mapbox.com/api/maps/static-images/
 */
function mapboxStaticUrl({ lat, lon }) {
  if (!MAPBOX_TOKEN) return null;
  const style = "mapbox/streets-v12";
  const center = `${lon.toFixed(5)},${lat.toFixed(5)},10`;
  const marker = `pin-s+000(${lon.toFixed(5)},${lat.toFixed(5)})`;
  const overlay = encodeURIComponent(marker);

  return `https://api.mapbox.com/styles/v1/${style}/static/${overlay}/${center}/${MAP_W}x${MAP_H}?access_token=${encodeURIComponent(
    MAPBOX_TOKEN
  )}`;
}

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Map image fetch failed HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function postDiscord({ content, imageUrl }) {
  // If imageUrl provided and MAPBOX_TOKEN set: attach image file to webhook
  if (imageUrl) {
    const img = await fetchImage(imageUrl);

    const form = new FormData();
    form.append("content", content);
    form.append("file", Readable.from(img), {
      filename: `map_${ICAO24}_${Date.now()}.png`,
      contentType: "image/png",
    });

    const res = await fetch(DISCORD_WEBHOOK_URL, { 
      method: "POST", 
      body: form,
      headers: form.getHeaders(),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Discord webhook failed HTTP ${res.status}: ${txt}`);
    }
    return;
  }

  // No image: simple JSON
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed HTTP ${res.status}: ${txt}`);
  }
}

// --- takeoff/landing state machine ---
const STATE = {
  UNKNOWN: "UNKNOWN",
  ON_GROUND: "ON_GROUND",
  AIRBORNE: "AIRBORNE",
};

let currentState = STATE.UNKNOWN;
let lastEvent = null; // { type, ts, lat, lon, gs, alt, callsign }
let lastPositionCheck = Date.now(); // Track when we last did a full position comparison
const POSITION_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let positionMismatchMode = false; // When true, we're actively checking for position convergence
let firstCheckSent = false; // Track if we've sent the first check notification
let lastKnownPosition = null; // Track last known position for update detection
let lastUpdateSent = 0; // Track when we last sent a position update
let lastPositionGroundNotificationSent = 0; // Track when we last sent a "last position on ground" notification
let lastStateCheck = Date.now(); // Track when we last checked aircraft state
const STATE_CHECK_INTERVAL_MS = STATE_CHECK_INTERVAL_SECONDS * 1000;
const UPDATE_INTERVAL_MS = UPDATE_INTERVAL_SECONDS * 1000;
const POSITION_UPDATE_THRESHOLD = 0.01; // Minimum position change to consider aircraft moving (degrees, ~1km)

function classify(snapshot) {
  // Prefer explicit ground flag if available, but backstop with alt/gs heuristics.
  const { isGround, gs, alt } = snapshot;

  if (isGround === true) return STATE.ON_GROUND;
  if (isGround === false) return STATE.AIRBORNE;

  // Heuristic fallback:
  // - airborne if alt significantly above ground and moving
  if (alt != null && typeof alt === "number" && alt >= TAKEOFF_ALT_MIN_FT && gs != null && gs >= TAKEOFF_GS_MIN_KTS) return STATE.AIRBORNE;
  // - ground if speed low and alt low-ish, or if alt is "ground" string
  if (alt === "ground" || (gs != null && gs <= LANDING_GS_MAX_KTS && (alt == null || (typeof alt === "number" && alt < TAKEOFF_ALT_MIN_FT)))) return STATE.ON_GROUND;

  return STATE.UNKNOWN;
}

function buildMessage({ eventType, snap, previousPosition = null, isLastPosition = false }) {
  const ts = Date.now();
  const { utc, local } = fmtTimeBoth(ts);

  let title = "";
  if (eventType === "TAKEOFF") title = "🛫 Takeoff";
  else if (eventType === "LANDING") title = "🛬 Landing";
  else if (eventType === "FIRST_CHECK") title = "📍 First Check - Aircraft Detected";
  else if (eventType === "POSITION_UPDATE") title = "📍 Position Update";
  else if (eventType === "LAST_POSITION_GROUND") title = "🛬 Last Known Position - On Ground";

  const lines = [
    `**${title}**`,
    `ICAO24: \`${ICAO24}\``,
    snap.callsign ? `Callsign: \`${snap.callsign}\`` : null,
    isLastPosition ? `⚠️ **Using last known position** (aircraft not currently transmitting)` : null,
    `Time (UTC): \`${utc}\``,
    `Time (Local): \`${local}\``,
    `Location: \`${snap.lat.toFixed(5)}, ${snap.lon.toFixed(5)}\``,
    snap.alt != null && typeof snap.alt !== "string" ? `Altitude: \`${snap.alt}\` ft` : (snap.alt === "ground" || snap.alt === "Ground" ? `Altitude: \`Ground\`` : null),
    snap.gs != null ? `Speed (GS): \`${snap.gs}\` kts` : null,
    snap.track != null ? `Heading: \`${snap.track}\`°` : null,
  ];

  // Add position change info for position updates
  if (eventType === "POSITION_UPDATE" && previousPosition) {
    const latDiff = snap.lat - previousPosition.lat;
    const lonDiff = snap.lon - previousPosition.lon;
    const distanceKm = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff) * 111; // Rough km conversion
    lines.push(`Distance moved: \`${distanceKm.toFixed(2)}\` km`);
    lines.push(`Previous location: \`${previousPosition.lat.toFixed(5)}, ${previousPosition.lon.toFixed(5)}\``);
  }

  lines.push(`Globe: ${GLOBE_URL}`);

  return lines.filter(Boolean).join("\n");
}

// HTTP API Server for managing ICAO24
function createAPIServer() {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const path = parsedUrl.pathname;
    const method = req.method;

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Helper function to check API key
    function checkAPIKey() {
      if (!API_KEY) return true; // No API key set, allow access
      
      const authHeader = req.headers.authorization;
      const apiKeyFromHeader = authHeader?.replace("Bearer ", "") || parsedUrl.searchParams.get("key");
      return apiKeyFromHeader === API_KEY;
    }

    try {
      // GET /api/icao - Get current ICAO24 (no auth required)
      if (path === "/api/icao" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          icao24: ICAO24,
          globe_url: GLOBE_URL,
          state: currentState,
          monitoring: !!ICAO24,
        }));
        return;
      }

      // PUT/POST /api/icao - Update ICAO24 (requires API_KEY if set)
      if (path === "/api/icao" && (method === "PUT" || method === "POST")) {
        // Check API key only for PUT/POST
        if (!checkAPIKey()) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized - Invalid or missing API key" }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          try {
            const data = body ? JSON.parse(body) : {};
            const newIcao = data.icao24 || data.icao || parsedUrl.searchParams.get("icao24") || parsedUrl.searchParams.get("icao");
            
            if (!newIcao) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing icao24 parameter" }));
              return;
            }

            const updated = updateICAO24(newIcao);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              icao24: updated,
              globe_url: GLOBE_URL,
              message: "ICAO24 updated successfully",
            }));
          } catch (error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error.message }));
          }
        });
        return;
      }

      // GET /api/status - Get current status (no auth required)
      if (path === "/api/status" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          icao24: ICAO24,
          state: currentState,
          globe_url: GLOBE_URL,
          last_event: lastEvent,
          last_known_position: lastKnownPosition,
          monitoring: !!ICAO24,
        }));
        return;
      }

      // 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  server.listen(API_PORT, () => {
    console.log(`[${nowIso()}] API server listening on port ${API_PORT}`);
    if (API_KEY) {
      console.log(`[${nowIso()}] API key protection enabled (required for PUT /api/icao)`);
    } else {
      console.log(`[${nowIso()}] ⚠️  API key not set - PUT endpoint is unprotected`);
    }
  });

  return server;
}

// Start API server
const apiServer = createAPIServer();

// Initialize monitoring
if (ICAO24 && /^[0-9a-f]{6}$/.test(ICAO24)) {
  console.log(`[${nowIso()}] Monitoring ${ICAO24}`);
  console.log(`[${nowIso()}] Globe link: ${GLOBE_URL}`);
} else {
  console.log(`[${nowIso()}] ⚠️  No ICAO24 set - use API to set one: PUT /api/icao`);
}

console.log(`[${nowIso()}] State check interval: ${STATE_CHECK_INTERVAL_SECONDS}s (${STATE_CHECK_INTERVAL_SECONDS / 60} min)`);
console.log(`[${nowIso()}] Polling: ${POLL_SECONDS}s (${POLL_SECONDS / 60} min) when AIRBORNE, ${GROUND_POLL_SECONDS}s (${GROUND_POLL_SECONDS / 60} min) when ON_GROUND`);
console.log(`[${nowIso()}] Position check interval: 24 hours`);

while (true) {
  try {
    // Skip if no ICAO24 is set
    if (!ICAO24 || !/^[0-9a-f]{6}$/.test(ICAO24)) {
      await new Promise((r) => setTimeout(r, 60000)); // Check every minute if ICAO24 is set
      continue;
    }

    const now = Date.now();
    const timeSinceLastCheck = now - lastPositionCheck;
    const timeSinceStateCheck = now - lastStateCheck;
    const shouldCheckPositions = timeSinceLastCheck >= POSITION_CHECK_INTERVAL_MS || positionMismatchMode;
    const shouldCheckState = timeSinceStateCheck >= STATE_CHECK_INTERVAL_MS;

    // Fetch snapshot (always fetches both last and live positions)
    const snap = await fetchAircraftSnapshot();

    if (!snap) {
      console.log(`[${nowIso()}] No aircraft data returned`);
      // If we're in mismatch mode and get no data, aircraft may have stopped reporting
      if (positionMismatchMode) {
        console.log(`[${nowIso()}] Aircraft stopped reporting during position mismatch check`);
        positionMismatchMode = false;
      }
    } else {
      // Check if we should verify positions (every 24 hours or in mismatch mode)
      if (shouldCheckPositions && snap.live && snap.last) {
        if (!snap.positionsMatch) {
          // Positions differ - enter mismatch mode
          if (!positionMismatchMode) {
            console.log(`[${nowIso()}] Position mismatch detected - entering verification mode`);
            positionMismatchMode = true;
          }
          console.log(
            `[${nowIso()}] Position mismatch: Live(${snap.live.lat.toFixed(5)}, ${snap.live.lon.toFixed(5)}) vs Last(${snap.last.lat.toFixed(5)}, ${snap.last.lon.toFixed(5)})`
          );
          // Continue checking until positions match or aircraft stops reporting
        } else {
          // Positions match - exit mismatch mode and reset timer
          if (positionMismatchMode) {
            console.log(`[${nowIso()}] Positions converged - exiting verification mode`);
            positionMismatchMode = false;
          }
          lastPositionCheck = now;
          console.log(`[${nowIso()}] Position check: Live and Last positions match`);
        }
      } else if (shouldCheckPositions) {
        // Reset timer even if we don't have both positions
        lastPositionCheck = now;
      }

      // Use live position if available and active, otherwise use last
      // Only process state changes if we have reliable data
      const useSnapshot = snap.live && snap.isActive ? snap.live : (snap.live || snap.last);
      
      if (!useSnapshot) {
        console.log(`[${nowIso()}] No usable position data`);
        continue;
      }

      // Create a snapshot object with the data we'll use for state detection
      const stateSnapshot = {
        ...useSnapshot,
        isActive: snap.isActive,
        positionsMatch: snap.positionsMatch,
      };

      // Check if we're using last position (not live) and aircraft is on ground
      const isUsingLastPosition = !snap.live || (!snap.isActive && snap.last);
      const isOnGround = stateSnapshot.isGround === true || 
                        (typeof stateSnapshot.alt === "string" && stateSnapshot.alt.toLowerCase() === "ground");

      // First check notification
      if (!firstCheckSent) {
        firstCheckSent = true;
        // If using last position and on ground, send special notification
        if (isUsingLastPosition && isOnGround) {
          const msg = buildMessage({ 
            eventType: "LAST_POSITION_GROUND", 
            snap: stateSnapshot,
            isLastPosition: true 
          });
          const imgUrl = mapboxStaticUrl(stateSnapshot);
          await postDiscord({ content: msg, imageUrl: imgUrl });
          lastPositionGroundNotificationSent = now;
          console.log(`[${nowIso()}] FIRST_CHECK posted (Last position, on ground)`);
        } else {
          const msg = buildMessage({ eventType: "FIRST_CHECK", snap: stateSnapshot });
          const imgUrl = mapboxStaticUrl(stateSnapshot);
          await postDiscord({ content: msg, imageUrl: imgUrl });
          console.log(`[${nowIso()}] FIRST_CHECK posted`);
        }
        lastKnownPosition = { lat: stateSnapshot.lat, lon: stateSnapshot.lon };
      }

      // 24-hour check: if using last position and on ground, send notification
      if (shouldCheckPositions && isUsingLastPosition && isOnGround) {
        // Only send if we haven't sent one recently (avoid spam during mismatch mode)
        const timeSinceLastGroundNotif = now - lastPositionGroundNotificationSent;
        if (timeSinceLastGroundNotif >= POSITION_CHECK_INTERVAL_MS / 2) { // At most every 12 hours
          const msg = buildMessage({ 
            eventType: "LAST_POSITION_GROUND", 
            snap: stateSnapshot,
            isLastPosition: true 
          });
          const imgUrl = mapboxStaticUrl(stateSnapshot);
          await postDiscord({ content: msg, imageUrl: imgUrl });
          lastPositionGroundNotificationSent = now;
          console.log(`[${nowIso()}] LAST_POSITION_GROUND posted (24-hour check)`);
        }
      }

      const newState = classify(stateSnapshot);

      // Initialize state on first meaningful read
      if (currentState === STATE.UNKNOWN && newState !== STATE.UNKNOWN) {
        currentState = newState;
        console.log(`[${nowIso()}] Initial state = ${currentState}`);
      }

      // Transition detection with extra confirmation:
      // Takeoff: transition to AIRBORNE AND meets thresholds
      // Only trigger if aircraft is actively transmitting (isActive)
      if (currentState === STATE.ON_GROUND && newState === STATE.AIRBORNE) {
        const ok =
          stateSnapshot.isActive && // Only if actively transmitting
          (stateSnapshot.gs != null ? stateSnapshot.gs >= TAKEOFF_GS_MIN_KTS : true) &&
          (stateSnapshot.alt != null ? stateSnapshot.alt >= TAKEOFF_ALT_MIN_FT : true);

        if (ok) {
          currentState = STATE.AIRBORNE;

          const msg = buildMessage({ eventType: "TAKEOFF", snap: stateSnapshot });
          const imgUrl = mapboxStaticUrl(stateSnapshot);

          await postDiscord({ content: msg, imageUrl: imgUrl });
          lastEvent = { type: "TAKEOFF", ts: Date.now(), ...stateSnapshot };
          console.log(`[${nowIso()}] TAKEOFF posted`);
        }
      }

      // Landing: transition to ON_GROUND AND speed low
      if (currentState === STATE.AIRBORNE && newState === STATE.ON_GROUND) {
        const ok = stateSnapshot.gs != null ? stateSnapshot.gs <= LANDING_GS_MAX_KTS : true;

        if (ok) {
          currentState = STATE.ON_GROUND;

          const msg = buildMessage({ eventType: "LANDING", snap: stateSnapshot });
          const imgUrl = mapboxStaticUrl(stateSnapshot);

          await postDiscord({ content: msg, imageUrl: imgUrl });
          lastEvent = { type: "LANDING", ts: Date.now(), ...stateSnapshot };
          console.log(`[${nowIso()}] LANDING posted`);
        }
      }

      // Position update detection - send at interval when aircraft is AIRBORNE
      // Send updates if aircraft is airborne, regardless of active transmission status
      if (newState === STATE.AIRBORNE || currentState === STATE.AIRBORNE) {
        const timeSinceLastUpdate = now - lastUpdateSent;
        const shouldSendUpdate = timeSinceLastUpdate >= UPDATE_INTERVAL_MS;

        if (shouldSendUpdate) {
          // Check if aircraft has moved (to avoid spamming if stationary)
          let hasMoved = true;
          let distanceKm = 0;
          
          if (lastKnownPosition) {
            const latDiff = Math.abs(stateSnapshot.lat - lastKnownPosition.lat);
            const lonDiff = Math.abs(stateSnapshot.lon - lastKnownPosition.lon);
            distanceKm = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff) * 111; // Rough km conversion
            hasMoved = latDiff >= POSITION_UPDATE_THRESHOLD || lonDiff >= POSITION_UPDATE_THRESHOLD;
          }

          // Send update if aircraft has moved, or if it's the first update after first check
          // For airborne aircraft, we're more lenient and send updates even if movement is minimal
          if (hasMoved || !lastKnownPosition || distanceKm > 0) {
            const msg = buildMessage({ 
              eventType: "POSITION_UPDATE", 
              snap: stateSnapshot,
              previousPosition: lastKnownPosition 
            });
            const imgUrl = mapboxStaticUrl(stateSnapshot);
            await postDiscord({ content: msg, imageUrl: imgUrl });
            lastUpdateSent = now;
            lastKnownPosition = { lat: stateSnapshot.lat, lon: stateSnapshot.lon };
            console.log(`[${nowIso()}] POSITION_UPDATE posted (AIRBORNE)${distanceKm > 0 ? ` (moved ${distanceKm.toFixed(2)} km)` : ""}`);
          }
        } else {
          // Update last known position even if not sending notification yet
          lastKnownPosition = { lat: stateSnapshot.lat, lon: stateSnapshot.lon };
        }
      } else if (!lastKnownPosition) {
        // Initialize last known position if not set
        lastKnownPosition = { lat: stateSnapshot.lat, lon: stateSnapshot.lon };
      }

      // Log basic telemetry with position status
      const posStatus = snap.live && snap.last 
        ? (snap.positionsMatch ? "match" : "mismatch") 
        : (snap.live ? "live-only" : "last-only");
      console.log(
        `[${nowIso()}] state=${currentState} active=${stateSnapshot.isActive ?? false} pos=${posStatus} lat=${stateSnapshot.lat.toFixed(5)} lon=${stateSnapshot.lon.toFixed(5)} gs=${stateSnapshot.gs ?? "n/a"} alt=${stateSnapshot.alt ?? "n/a"} gnd=${stateSnapshot.isGround ?? "n/a"}`
      );

      // Update state check timestamp if we checked state
      if (shouldCheckState) {
        lastStateCheck = now;
      }
    }
  } catch (e) {
    console.error(`[${nowIso()}] ERROR:`, e?.message || e);
  }

  // Determine polling interval based on current state
  // Use faster polling (POLL_SECONDS) when airborne, slower (GROUND_POLL_SECONDS) when on ground
  const pollInterval = currentState === STATE.AIRBORNE ? POLL_SECONDS : GROUND_POLL_SECONDS;
  await new Promise((r) => setTimeout(r, pollInterval * 1000));
}

