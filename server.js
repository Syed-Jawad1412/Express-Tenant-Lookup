import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// cache: domain -> { data, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeDomain(input) {
  let d = String(input || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.split("/")[0];
  d = d.replace(/\s+/g, "");

  // basic domain validation
  const re = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
  if (!re.test(d)) return null;
  return d;
}

function getBaseName(domain) {
  // ibseleven.com -> ibseleven
  // sub.ibseleven.com -> sub (simple heuristic)
  return domain.split(".")[0];
}

function extractTenantIdFromIssuer(issuer) {
  // issuer: https://login.microsoftonline.com/<tenantId>/v2.0
  const m = String(issuer || "").match(
    /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0/i
  );
  return m ? m[1] : null;
}

async function fetchOpenIdConfig(domain) {
  const cached = cache.get(domain);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, data: cached.data, cached: true };
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(
    domain
  )}/v2.0/.well-known/openid-configuration`;

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status };

  const json = await r.json();
  const issuer = json.issuer;
  const tenantId = extractTenantIdFromIssuer(issuer);

  if (!tenantId) return { ok: false, status: 500 };

  const result = {
    domain,
    tenantId,
    issuer,
    authorization_endpoint: json.authorization_endpoint,
    token_endpoint: json.token_endpoint,
  };

  cache.set(domain, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return { ok: true, data: result, cached: false };
}

async function runWithConcurrency(items, workerFn, concurrency = 5) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (true) {
      const current = idx++;
      if (current >= items.length) break;
      results[current] = await workerFn(items[current], current);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results;
}

// ✅ SMART single lookup (custom -> fallback onmicrosoft)
app.get("/api/tenant-smart", async (req, res) => {
  try {
    const input = req.query.domain;
    const domain = normalizeDomain(input);

    if (!domain) {
      return res.status(400).json({
        error: "Invalid domain",
        hint: "Example: ibseleven.com",
      });
    }

    // 1) Try original domain first
    const first = await fetchOpenIdConfig(domain);
    if (first.ok) {
      return res.json({
        inputDomain: domain,
        resolvedDomain: first.data.domain,
        usedFallback: false,
        cached: first.cached,
        tenantId: first.data.tenantId,
        issuer: first.data.issuer,
      });
    }

    // 2) If fails, try guessed onmicrosoft fallback
    if (domain.endsWith(".onmicrosoft.com")) {
      return res.status(404).json({
        error: "Domain not resolvable in Entra ID",
        inputDomain: domain,
        tried: [domain],
        hint: "Make sure the domain is a verified domain in Entra ID.",
      });
    }

    const base = getBaseName(domain);
    const fallback = `${base}.onmicrosoft.com`;

    const second = await fetchOpenIdConfig(fallback);
    if (second.ok) {
      return res.json({
        inputDomain: domain,
        resolvedDomain: second.data.domain,
        usedFallback: true,
        fallbackTried: fallback,
        cached: second.cached,
        tenantId: second.data.tenantId,
        issuer: second.data.issuer,
      });
    }

    // Both failed
    return res.status(404).json({
      error: "Tenant not found for domain (original and fallback failed)",
      inputDomain: domain,
      tried: [domain, fallback],
      hint:
        "Try the tenant's exact *.onmicrosoft.com name (it may not match the first label of your custom domain).",
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// ✅ BULK lookup (array) + export ready JSON
app.post("/api/tenant-bulk", async (req, res) => {
  try {
    const domainsRaw = req.body?.domains;

    if (!Array.isArray(domainsRaw) || domainsRaw.length === 0) {
      return res.status(400).json({ error: "domains[] is required" });
    }

    // safety limit
    const domains = domainsRaw.slice(0, 200);

    const results = await runWithConcurrency(
      domains,
      async (d) => {
        const domain = normalizeDomain(d);

        if (!domain) {
          return {
            inputDomain: String(d || ""),
            success: false,
            error: "Invalid domain format",
            tried: [],
          };
        }

        // 1) try original
        const first = await fetchOpenIdConfig(domain);
        if (first.ok) {
          return {
            inputDomain: domain,
            resolvedDomain: first.data.domain,
            usedFallback: false,
            tenantId: first.data.tenantId,
            issuer: first.data.issuer,
            cached: first.cached,
            success: true,
          };
        }

        // 2) fallback (if not already onmicrosoft)
        if (!domain.endsWith(".onmicrosoft.com")) {
          const base = getBaseName(domain);
          const fallback = `${base}.onmicrosoft.com`;

          const second = await fetchOpenIdConfig(fallback);
          if (second.ok) {
            return {
              inputDomain: domain,
              resolvedDomain: second.data.domain,
              usedFallback: true,
              fallbackTried: fallback,
              tenantId: second.data.tenantId,
              issuer: second.data.issuer,
              cached: second.cached,
              success: true,
            };
          }

          return {
            inputDomain: domain,
            success: false,
            error: "Not found (original + fallback failed)",
            tried: [domain, fallback],
          };
        }

        return {
          inputDomain: domain,
          success: false,
          error: "Not found",
          tried: [domain],
        };
      },
      6 // concurrency
    );

    res.json({
      count: results.length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);