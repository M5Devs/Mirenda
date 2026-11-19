# `services/proxy-go`

Placeholder Go module for Mirenda's future tunneling / VPN service.

**License:** AGPL-3.0-only (matches the repository root).

## Status

Phase 1 ships the module skeleton only. The service is intentionally a
**stub**: it compiles, exposes a health endpoint, and documents the interface it
will implement. No tunneling code exists yet.

## Planned responsibilities

| Capability | Notes |
| --- | --- |
| **WireGuard tunnel** | Terminate a per-session WireGuard peer so a profile's traffic egresses from a stable IP. |
| **SOCKS5 listener** | Local SOCKS5 endpoint the Worker's proxy can dial through for regions where a direct fetch is blocked. |
| **Profile isolation** | One tunnel per `(user_id, profile_id)`, torn down when the profile goes idle. |
| **Key handling** | WireGuard private keys are generated per session in memory and never persisted. |

## Interface contract (draft)

The Worker talks to this service over an authenticated HTTP/2 control channel:

- `POST /v1/tunnels` → `{ tunnelId, socksEndpoint, expiresAt }`
- `DELETE /v1/tunnels/{tunnelId}`
- `GET /healthz`

Tunnel credentials are short-lived bearer tokens minted by the Worker; the
service never sees a Mirenda session cookie or a user password.

## Build

```bash
cd services/proxy-go
go build ./...
go run ./cmd/mirenda-proxyd
```

The module has no third-party dependencies in Phase 1, so `go build` works
offline.
