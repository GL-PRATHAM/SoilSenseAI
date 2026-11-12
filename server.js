const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const allowedOrigins = new Set([
  "https://gl-pratham.github.io",
  "https://pratham.github.io",
  "https://soilsenseai.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  ...(process.env.FRONTEND_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);

app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server and local health checks with no Origin header.
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400,
}));

app.use(express.json({ limit: "12mb" }));

// Lightweight per-IP request limit to reduce accidental quota abuse.
const requestCounts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 30;

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let entry = requestCounts.get(key);

  if (!entry || now - entry.startedAt >= WINDOW_MS) {
    entry = { startedAt: now, count: 0 };
  }

  entry.count += 1;
  requestCounts.set(key, entry);

  if (entry.count > MAX_REQUESTS) {
    return res.status(429).json({
      error: { message: "Too many requests. Please wait a few minutes and try again." },
    });
  }

  // Opportunistically remove expired entries.
  if (requestCounts.size > 5000) {
    for (const [ip, value] of requestCounts) {
      if (now - value.startedAt >= WINDOW_MS) requestCounts.delete(ip);
    }
  }

  next();
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    provider: "Google Gemini",
    configured: Boolean(process.env.GEMINI_API_KEY),
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  });
});

function toGeminiContents(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("A messages array is required.");
  }

  return messages.map((message) => {
    const role = message.role === "assistant" ? "model" : "user";
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content || "") }];
    const parts = [];

    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        parts.push({ text: block.text });
      } else if (block.type === "image") {
        const source = block.source || {};
        if (source.type !== "base64" || typeof source.data !== "string") {
          throw new Error("Image must be supplied as base64 data.");
        }
        const mimeType = source.media_type || "image/jpeg";
        if (!["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(mimeType)) {
          throw new Error("Unsupported image format. Use JPEG, PNG, or WebP.");
        }
        if (source.data.length > 10_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data)) {
          throw new Error("The image data is invalid or too large.");
        }
        parts.push({ inline_data: { mime_type: mimeType, data: source.data } });
      }
    }

    if (parts.length === 0) throw new Error("Message content is empty.");
    return { role, parts };
  });
}

async function handleGeminiRequest(req, res) {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: { message: "Gemini API is not configured. Add GEMINI_API_KEY in Render Environment settings." },
    });
  }

  let contents;
  try {
    contents = toGeminiContents(req.body.messages);
  } catch (error) {
    return res.status(400).json({ error: { message: error.message } });
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const requestedTokens = Number(req.body.max_tokens) || 1400;
  const maxOutputTokens = Math.min(Math.max(requestedTokens, 128), 8192);

  try {
    // Retry temporary Google API/network failures and fail over to another
    // supported Flash model if the primary model is temporarily unavailable.
    const modelCandidates = [...new Set([
      model,
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
    ])];
    let response = null;
    let activeModel = model;
    let lastNetworkError = null;

    for (const candidate of modelCandidates) {
      activeModel = candidate;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidate)}:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": process.env.GEMINI_API_KEY,
              },
              body: JSON.stringify({
                contents,
                generationConfig: { maxOutputTokens },
              }),
              signal: AbortSignal.timeout(45000),
            }
          );
          lastNetworkError = null;

          // A 429 can be model-specific. Do not hammer the same model:
          // move immediately to the next supported Flash candidate.
          // Retry only transient upstream capacity/server failures.
          if (response.status === 429 || response.status === 404) break;
          if (![502, 503, 504].includes(response.status)) break;
        } catch (error) {
          lastNetworkError = error;
          response = null;
        }

        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 700 * (2 ** attempt)));
        }
      }

      if (response?.ok) break;
      if (response && [429, 404, 502, 503, 504].includes(response.status)) continue;
      if (response) break;
    }

    if (!response) {
      throw lastNetworkError || new Error("Gemini could not be reached after retries.");
    }

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      const status = response.status === 429 ? 429 : response.status === 400 ? 400 : response.status === 403 ? 403 : 502;
      const message = status === 429
        ? "Google Gemini returned a quota/rate-limit response for the available models. Free-tier limits may be exhausted; wait for the quota window to reset or check Google AI Studio usage and model limits."
        : status === 403
          ? "Gemini rejected the API key or the key does not have access to this model. Check Google AI Studio and Render Environment settings."
          : status === 400
            ? "Gemini rejected the request. Check the image format and input values."
            : "Gemini is temporarily unavailable. Please try again.";
      console.error("Gemini request failed with HTTP status:", response.status, "model:", activeModel);
      return res.status(status).json({ error: { message } });
    }

    const text = (result.candidates || [])
      .flatMap((candidate) => candidate.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    if (!text) {
      return res.status(502).json({
        error: { message: "Gemini returned an empty response. Please try a clearer image or revise the input." },
      });
    }

    // Preserve the response shape expected by the existing three frontend tools.
    return res.json({ content: [{ text }] });
  } catch (error) {
    console.error("Gemini network error after retries/model fallback:", error.message);
    return res.status(502).json({
      error: { message: "Could not reach Gemini. Please try again in a moment." },
    });
  }
}

app.post("/api/gemini", rateLimit, handleGeminiRequest);
// Backward-compatible alias in case an older frontend is still cached.
app.post("/api/claude", rateLimit, handleGeminiRequest);

app.use((err, req, res, next) => {
  if (err && err.message === "Origin is not allowed by CORS") {
    return res.status(403).json({ error: { message: "This website origin is not allowed." } });
  }
  console.error("Server error:", err.message);
  return res.status(500).json({ error: { message: "Unexpected server error." } });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SoilSense AI Gemini backend listening on port ${PORT}`);
});
