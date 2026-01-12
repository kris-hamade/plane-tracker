# Plane Tracker

ADS-B takeoff/landing notifier with Discord webhook integration. Monitors an aircraft by ICAO24/HEX code and sends notifications when takeoff or landing events are detected.

## Features

- 🛫 **Takeoff Detection**: Monitors aircraft state transitions from ground to airborne
- 🛬 **Landing Detection**: Monitors aircraft state transitions from airborne to ground
- 📍 **Location Data**: Includes lat/lon coordinates in notifications
- 🗺️ **Map Images**: Optional Mapbox static map image attachments
- 🔗 **Globe Links**: Includes direct links to ADSBexchange Globe for live tracking
- ⚡ **Real-time**: Polls ADSBexchange API at configurable intervals

## Prerequisites

- Node.js 18+ (ES modules support)
- ADSBexchange API credentials (UUID)
- Discord webhook URL
- (Optional) Mapbox access token for map images

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   
   Copy `env.example` to `.env` and fill in your values:
   ```bash
   cp env.example .env
   ```
   
   Or create a `.env` file manually with the following variables:

   ```env
   # Required
   RAPIDAPI_KEY=your-rapidapi-key-here
   ICAO24=4867e6
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-url-here

   # Optional
   POLL_SECONDS=15
   MAPBOX_TOKEN=
   MAP_W=900
   MAP_H=500
   ```

   **Required variables:**
   - `RAPIDAPI_KEY`: Your RapidAPI key for ADSBexchange (get from [RapidAPI](https://rapidapi.com/adsbexchange-com1-adsbexchange-com1-default/api/adsbexchange-com1))
   - `ICAO24`: The 6-character hex code of the aircraft to monitor (e.g., `4867e6`) - can also be set via API
   - `DISCORD_WEBHOOK_URL`: Your Discord webhook URL

   **Optional API variables:**
   - `API_PORT`: Port for the HTTP API server (default: 3000)
   - `API_KEY`: Optional API key for securing endpoints (recommended if exposed to network)

   **Optional variables:**
   - `POLL_SECONDS`: Polling interval in seconds when aircraft is AIRBORNE (default: 300 = 5 minutes)
   - `GROUND_POLL_SECONDS`: Polling interval in seconds when aircraft is ON_GROUND (default: 900 = 15 minutes)
   - `STATE_CHECK_INTERVAL_SECONDS`: How often to check if plane is on-ground or airborne (default: 1800 = 30 minutes)
   - `UPDATE_INTERVAL_SECONDS`: Position update interval in seconds when aircraft is AIRBORNE (default: 300 = 5 minutes)
   - `MAPBOX_TOKEN`: Mapbox access token for map image attachments
   - `MAP_W`, `MAP_H`: Map image dimensions (default: 900x500)

3. **Run the application:**
   ```bash
   npm start
   ```

   Or directly:
   ```bash
   node notifier.mjs
   ```

## How It Works

### Dual-Endpoint Position Verification

The application uses both ADSBexchange endpoints for enhanced reliability:

1. **Live Position** (`/v2/icao/{icao}/`): Current real-time position
2. **Last Position** (`/v2/hex/{icao}/`): Last known position

**Position Comparison Logic:**
- Every 24 hours, the app compares live vs last position
- If positions differ, it enters "verification mode" and continues checking
- Verification continues until positions converge or aircraft stops reporting
- This helps ensure we're tracking active aircraft and reduces false positives

**Active Aircraft Detection:**
- Aircraft is considered "active" when live position exists and differs from last position
- State changes (takeoff/landing) only trigger when aircraft is actively transmitting

**Adaptive Polling:**
- Every 30 minutes: Check if aircraft is ON_GROUND or AIRBORNE
- When ON_GROUND: Poll at slower interval (default: 15 minutes) to check if plane becomes active
- When AIRBORNE: Poll at faster interval (default: 5 minutes) for position updates
- Every 24 hours: Report status/position regardless of state

### Notification Types

1. **First Check**: Sent once when the aircraft is first detected
2. **Position Updates**: Sent at regular intervals (configurable via `UPDATE_INTERVAL_SECONDS`) when the aircraft is actively moving
3. **Takeoff**: Detected when aircraft transitions from ground to airborne
4. **Landing**: Detected when aircraft transitions from airborne to ground

### Detection Logic

The application uses a state machine to track aircraft status:

1. **State Classification**: 
   - Uses the `gnd`/`on_ground` flag from ADSBexchange when available
   - Falls back to heuristics based on altitude and ground speed if the flag is unreliable

2. **Takeoff Detection**:
   - Transition from `ON_GROUND` → `AIRBORNE`
   - Confirms with speed threshold (≥50 kts) and altitude threshold (≥200 ft)
   - Only triggers when aircraft is actively transmitting (live position differs from last)

3. **Landing Detection**:
   - Transition from `AIRBORNE` → `ON_GROUND`
   - Confirms with speed threshold (≤30 kts)

4. **Position Updates**:
   - Sent at regular intervals (default: every 5 minutes) when aircraft is actively moving
   - Only sends if aircraft has moved at least ~1km since last update (prevents spam when stationary)
   - Includes current position, altitude, speed, heading, and distance moved

### Detection Logic

The application uses a state machine to track aircraft status:

1. **State Classification**: 
   - Uses the `gnd`/`on_ground` flag from ADSBexchange when available
   - Falls back to heuristics based on altitude and ground speed if the flag is unreliable

2. **Takeoff Detection**:
   - Transition from `ON_GROUND` → `AIRBORNE`
   - Confirms with speed threshold (≥50 kts) and altitude threshold (≥200 ft)
   - Only triggers when aircraft is actively transmitting (live position differs from last)

3. **Landing Detection**:
   - Transition from `AIRBORNE` → `ON_GROUND`
   - Confirms with speed threshold (≤30 kts)

### Notification Format

Discord notifications include:
- Event type (Takeoff/Landing)
- ICAO24 code
- Callsign (if available)
- Timestamp (UTC and local)
- Location coordinates
- Altitude and ground speed (if available)
- Link to ADSBexchange Globe
- Optional map image attachment

## Configuration

### Thresholds

You can adjust detection thresholds in `notifier.mjs`:

```javascript
const TAKEOFF_GS_MIN_KTS = 50;  // Minimum ground speed for takeoff confirmation
const TAKEOFF_ALT_MIN_FT = 200; // Minimum altitude for takeoff confirmation
const LANDING_GS_MAX_KTS = 30;  // Maximum ground speed for landing confirmation
```

### Polling Interval

Set `POLL_SECONDS` in your `.env` file to control how often the API is polled. Lower values provide faster detection but increase API usage.

## API Sources

This application uses the **ADSBexchange API via RapidAPI**:
- Endpoint: `https://adsbexchange-com1.p.rapidapi.com/v2/icao/{icao24}/`
- Requires `x-rapidapi-key` header with your RapidAPI key
- See [RapidAPI ADSBexchange docs](https://rapidapi.com/adsbexchange-com1-adsbexchange-com1-default/api/adsbexchange-com1) for details

## Safety & Privacy

⚠️ **Important**: Only track aircraft you own, operate, or have explicit permission to track. Respect privacy and aviation regulations.

## Troubleshooting

### "No aircraft data returned"
- Verify the ICAO24 code is correct
- Check that the aircraft is currently transmitting ADS-B data
- Ensure your API credentials are valid

### "ADSBx HTTP 401/403"
- Verify your `RAPIDAPI_KEY` is correct
- Check that your RapidAPI key is active and has access to the ADSBexchange API

### Discord webhook fails
- Verify your webhook URL is correct
- Check that the webhook hasn't been deleted in Discord
- Ensure the webhook has permission to post messages

## API Endpoints

The application includes an HTTP API server for managing the ICAO24 code dynamically:

### Get Current ICAO24
```bash
GET http://localhost:3000/api/icao
```

Response:
```json
{
  "icao24": "4867e6",
  "globe_url": "https://globe.adsbexchange.com/?icao=4867e6",
  "state": "ON_GROUND",
  "monitoring": true
}
```

### Update ICAO24
```bash
PUT http://localhost:3000/api/icao
Content-Type: application/json

{
  "icao24": "abc123"
}
```

Or with query parameter:
```bash
PUT http://localhost:3000/api/icao?icao24=abc123
```

Response:
```json
{
  "success": true,
  "icao24": "abc123",
  "globe_url": "https://globe.adsbexchange.com/?icao=abc123",
  "message": "ICAO24 updated successfully"
}
```

### Get Status
```bash
GET http://localhost:3000/api/status
```

Response:
```json
{
  "icao24": "4867e6",
  "state": "AIRBORNE",
  "globe_url": "https://globe.adsbexchange.com/?icao=4867e6",
  "last_event": { "type": "TAKEOFF", "ts": 1234567890 },
  "last_known_position": { "lat": 43.67, "lon": 7.22 },
  "monitoring": true
}
```

### API Security

**Note:** `API_KEY` is only required for the PUT endpoint (updating ICAO24). GET endpoints are publicly accessible.

If `API_KEY` is set in your `.env` file, include it in PUT requests:

**Header:**
```bash
Authorization: Bearer your-api-key-here
```

**Query Parameter:**
```bash
?key=your-api-key-here
```

Example protected PUT request:
```bash
curl -X PUT http://localhost:3000/api/icao \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key-here" \
  -d '{"icao24": "abc123"}'
```

## License

MIT
