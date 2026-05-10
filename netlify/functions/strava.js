// Strava OAuth2 + upload via Netlify Function
// Environment variables: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, SITE_URL
//
// Endpoints:
//   GET  /api/strava/connect     → returns { url: "https://strava.com/oauth/..." }
//   GET  /api/strava/callback?code=xxx  → exchanges code, returns { connected: true }
//   GET  /api/strava/status     → returns { connected, expiresAt }
//   POST /api/strava/upload     → body: { gpx } → uploads activity to Strava

const crypto = require("crypto");

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const SITE_URL = process.env.SITE_URL || "http://localhost:8888";

const STATE_COOKIE = "strava_state";
const TOKEN_KEY = "strava_token";

// ---------------------------------------------------------------------------
// Helper: set/get cookies
// ---------------------------------------------------------------------------
function setCookie(name, value, maxAgeSec = 86400) {
  return {
    "Set-Cookie": `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeSec}; Path=/; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
  };
}

function getCookie(event, name) {
  const cookie = event.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)(\w+)=(\S+)/g);
  if (!match) return null;
  for (const m of match) {
    const [k, v] = m.split("=");
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function clearCookie(name) {
  return {
    "Set-Cookie": `${name}=; Max-Age=0; Path=/; SameSite=Lax`,
  };
}

// ---------------------------------------------------------------------------
// Helper: JSON response
// ---------------------------------------------------------------------------
function jsonRes(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": SITE_URL,
      "Access-Control-Allow-Credentials": "true",
    },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// State management (simple in-memory for demo; swap for Redis in production)
// ---------------------------------------------------------------------------
const stateStore = {};

function saveState(state, tokenData) {
  stateStore[state] = tokenData;
}

function getState(state) {
  return stateStore[state];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

exports.handler = async (event, context) => {
  const path = event.path.replace("/.netlify/functions/strava", "");
  const method = event.httpMethod;

  // --- CONNECT: return Strava OAuth URL ---
  if (path === "/connect" && method === "GET") {
    if (!STRAVA_CLIENT_ID) {
      return jsonRes(500, { error: "STRAVA_CLIENT_ID not set" });
    }
    const state = crypto.randomBytes(16).toString("hex");
    const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&redirect_uri=${encodeURIComponent(SITE_URL + "/.netlify/functions/strava/callback")}&response_type=code&scope=activity:write,activity:read_all&state=${state}`;
    return jsonRes(200, { url, state });
  }

  // --- CALLBACK: Strava redirects here with code ---
  if (path === "/callback" && method === "GET") {
    const params = new URLSearchParams(event.queryStringParameters);
    const code = params.get("code");
    const state = params.get("state");

    if (!code) {
      return jsonRes(400, { error: "No code provided" });
    }

    try {
      const tokenRes = await fetch("https://www.strava.com/api/v3/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: STRAVA_CLIENT_ID,
          client_secret: STRAVA_CLIENT_SECRET,
          code,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenRes.ok) {
        console.error("Strava token exchange failed:", tokenData);
        return jsonRes(401, { error: "Failed to exchange token" });
      }

      const newState = crypto.randomBytes(16).toString("hex");
      saveState(newState, tokenData);

      // Return HTML that stores state in a cookie and redirects
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "text/html",
          "Set-Cookie": `${STATE_COOKIE}=${newState}; Max-Age=300; Path=/; SameSite=Lax`,
        },
        body: `<!DOCTYPE html><html><head><title>Connected!</title></head>
<body style="font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fdf8ed;">
<div style="text-align:center;">
<h1>✅ Strava Connected</h1>
<p>You can close this tab and return to the app.</p>
<p style="color:#888;font-size:13px;">Your ride data will sync on your next upload.</p>
</div>
</body></html>`,
      };
    } catch (err) {
      console.error("Strava callback error:", err.message);
      return jsonRes(500, { error: "Token exchange failed" });
    }
  }

  // --- STATUS: check if user is connected ---
  if (path === "/status" && method === "GET") {
    const state = getCookie(event, STATE_COOKIE);
    if (!state) return jsonRes(200, { connected: false });
    const data = getState(state);
    if (!data) return jsonRes(200, { connected: false });

    const expired = Date.now() / 1000 > (data.expires_at || 0);
    return jsonRes(200, {
      connected: !expired,
      athlete: data.athlete,
      expiresAt: data.expires_at,
      state,
    });
  }

  // --- UPLOAD: POST GPX to Strava ---
  if (path === "/upload" && method === "POST") {
    const state = getCookie(event, STATE_COOKIE);
    if (!state) return jsonRes(401, { error: "Not connected" });

    const data = getState(state);
    if (!data) return jsonRes(401, { error: "Session expired" });

    const token = data.access_token;

    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return jsonRes(400, { error: "Invalid JSON body" });
    }

    const { gpx, name } = body;
    if (!gpx) return jsonRes(400, { error: "No GPX data provided" });

    try {
      const form = new FormData();
      form.append("file", new Blob([gpx], { type: "application/gpx+xml" }), "ride.gpx");
      form.append("data_type", "gpx");
      form.append("name", name || `SG Cycle Ops – ${new Date().toISOString().slice(0, 10)}`);
      form.append("description", "Upload from SG Cycle Ops PWA 🚲");
      form.append("external_id", `sgcycleops-${Date.now()}`);

      const uploadRes = await fetch("https://www.strava.com/api/v3/uploads", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      const result = await uploadRes.json();
      if (!uploadRes.ok) {
        console.error("Strava upload failed:", result);
        // If token expired, try refreshing
        if (uploadRes.status === 401 && data.refresh_token) {
          const refresh = await fetch("https://www.strava.com/api/v3/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: STRAVA_CLIENT_ID,
              client_secret: STRAVA_CLIENT_SECRET,
              refresh_token: data.refresh_token,
              grant_type: "refresh_token",
            }),
          });
          const newToken = await refresh.json();
          if (refresh.ok) {
            saveState(state, { ...data, ...newToken });
            // Retry upload
            const retryForm = new FormData();
            retryForm.append("file", new Blob([gpx], { type: "application/gpx+xml" }), "ride.gpx");
            retryForm.append("data_type", "gpx");
            retryForm.append("name", name || "SG Cycle Ops Ride");
            retryForm.append("description", "Upload from SG Cycle Ops PWA 🚲");
            retryForm.append("external_id", `sgcycleops-${Date.now()}`);

            const retryRes = await fetch("https://www.strava.com/api/v3/uploads", {
              method: "POST",
              headers: { Authorization: `Bearer ${newToken.access_token}` },
              body: retryForm,
            });
            const retryResult = await retryRes.json();
            return jsonRes(retryRes.ok ? 200 : 400, retryResult);
          }
        }
        return jsonRes(uploadRes.status, result);
      }
      return jsonRes(200, result);
    } catch (err) {
      console.error("Strava upload error:", err.message);
      return jsonRes(500, { error: "Upload failed" });
    }
  }

  // --- Disconnect ---
  if (path === "/disconnect" && method === "POST") {
    const state = getCookie(event, STATE_COOKIE);
    if (state && stateStore[state]) delete stateStore[state];
    return jsonRes(200, { disconnected: true }, [clearCookie(STATE_COOKIE)]);
  }

  return jsonRes(404, { error: "Not found" });
};