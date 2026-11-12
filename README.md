# Express Tenant Lookup

A Node.js and Express API for looking up Microsoft Entra tenant IDs from domain names using public Microsoft OpenID Connect metadata.

## Features

- Single-domain lookup with normalized domain input.
- Bulk lookup for up to 200 domains per request, processed with six concurrent workers.
- In-memory metadata caching with a ten-minute expiry.
- A fallback guess using the first domain label followed by `.onmicrosoft.com`.

The fallback is a heuristic: a successful result can belong to the guessed domain rather than the original domain. Check `resolvedDomain` and `usedFallback` before using a result.

## Requirements

Use a currently supported Node.js release with built-in `fetch`, and npm. The API calls Microsoft's public metadata endpoint, so lookup requests require internet access.

## Run locally

```sh
npm ci
node server.js
```

The default port is `5000`. Set the `PORT` environment variable to use another port.

## API

### Single lookup

```http
GET /api/tenant-smart?domain=example.com
```

Successful responses include `inputDomain`, `resolvedDomain`, `usedFallback`, `cached`, `tenantId` and `issuer`. Lookup success depends on the supplied domain being resolvable through Microsoft identity metadata.

### Bulk lookup

```http
POST /api/tenant-bulk
Content-Type: application/json

{"domains": ["example.com", "example.onmicrosoft.com"]}
```

The response contains a result count and per-domain success or error details. Only the first 200 entries are processed. This backend returns JSON; CSV export, if implemented, belongs to the client.

## Repository structure

```text
server.js          Express server and tenant lookup routes
package.json       Dependencies and package metadata
package-lock.json  Reproducible dependency lockfile
tenant-server.zip  Original source archive retained for reference
```

The source has been extracted from the original archive so it can be browsed and reviewed directly on GitHub. Runtime logic is unchanged.

## Related project

[React Tenant Lookup](https://github.com/Syed-Jawad1412/React-Tenant-Lookup) is the associated frontend repository.

## Current limitations

- No automated tests are currently implemented; the existing `npm test` script is a placeholder.
- The current server enables CORS broadly and does not implement authentication, rate limiting or outbound request timeouts. Review deployment requirements before exposing it publicly.
- The in-memory cache is per process and does not survive restarts.

## License

The package metadata declares ISC. No standalone license file is currently included in this repository.
