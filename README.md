[![Release npm](https://github.com/dynamiatools/buckie-node-js/actions/workflows/release-npm.yml/badge.svg)](https://github.com/dynamiatools/buckie-node-js/actions/workflows/release-npm.yml)

# Buckie Node.js

Node.js 24 implementation of Buckie — a filesystem-native file server with a minimal S3-style REST API optimized for secure server-to-server file operations.

---

## Features

- **Zero database** — no database, no message broker, no cloud account required; just a process and a disk
- **Single config file** — the entire server state (buckets, identities, grants) lives in one `config.json`, making it trivial to version-control, back up or inject via Docker
- **Streaming by design** — files are piped directly from disk to the HTTP response with constant memory usage regardless of file size
- **Multi-tenant ready** — prefix-based grants let multiple tenants share a single server while staying fully isolated
- **On-the-fly thumbnails** — images are resized and cached automatically via Sharp; no extra service needed
- **SFTP storage backend** — store files on a remote SFTP server with local-staging atomic commits
- **Programmatic API** — full TypeScript SDK for embedding Buckie into any Node.js application
- **Docker-friendly** — mount a single `config.json` and the server is fully configured at startup

---

## Requirements

| Requirement | Minimum |
|---|---|
| Node.js | **24.0.0** |
| npm | 9+ (or pnpm 8+) |

---

## Installation

```bash
npm install -g @dynamia-tools/buckie
```

Or use without installing:

```bash
npx @dynamia-tools/buckie serve
```

---

## Quick Start

```bash
# Create a local bucket
buckie create bucket documents /mnt/storage/documents

# Create an SFTP bucket
buckie create bucket remote-docs /uploads \
  --storage sftp \
  --sftp-host storage.example.com \
  --sftp-username deploy \
  --sftp-private-key "$(cat ~/.ssh/id_rsa)"

# Create an identity
buckie create identity erp-prod my-secret-password

# Grant permissions
buckie grant erp-prod documents --read --write --delete --prefix /tenant-a/

# Start the server
buckie serve --host 0.0.0.0 --port 8080
```

---

## CLI Reference

### Tab Completion

```bash
# Bash — add to ~/.bashrc
eval "$(buckie completion bash)"

# Zsh — add to ~/.zshrc  (compinit must already be loaded)
eval "$(buckie completion zsh)"

# Fish — save to completions directory
buckie completion fish > ~/.config/fish/completions/buckie.fish
```

### Commands

```bash
# Server
buckie serve [--host <host>] [--port <port>] [--data-dir <dir>] [--log-level <level>]

# Buckets
buckie create bucket <name> <absolutePath> [--storage local|sftp] [--sftp-host <host>] \
       [--sftp-port <port>] [--sftp-username <user>] [--sftp-password <pass>] \
       [--sftp-private-key <pem>] [--sftp-passphrase <phrase>]
buckie list buckets
buckie remove bucket <name>

# Identities
buckie create identity <identity> <secret>
buckie list identities
buckie remove identity <identity>

# Permissions
buckie grant <identity> <bucket> --read --write --delete [--prefix <path>]
buckie revoke <identity> <bucket>

# Files
buckie list files <bucket> [path]
buckie upload <bucket> <key> <localFile>
buckie copy <srcBucket> <srcKey> <dstBucket> <dstKey>

# Provisioning (create identity + secret + grant in one step)
buckie provision <bucket> [--identity <name>] [--prefix <path>] [--read] [--write] [--delete]
```

---

## REST API

All requests (except `GET /health`) require authentication via `X-Buckie-Identity` + `X-Buckie-Secret` headers, or HTTP Basic Auth.

### Health check
```http
GET /health
```

### Download a file
```http
GET /:bucket/:key
X-Buckie-Identity: erp-prod
X-Buckie-Secret: my-secret-password
```

### Download a thumbnail (on-the-fly resize)
```http
GET /:bucket/:key?w=300&h=300&fit=cover&format=webp
```

Supported query parameters: `w` (width), `h` (height), `fit` (`cover` | `contain` | `fill`), `format` (`webp` | `jpeg` | `png`).

### List a directory
```http
GET /:bucket/:path/
```

### List bucket contents (paginated)
```http
GET /:bucket?limit=100&cursor=...
```

### Upload a file
```http
PUT /:bucket/:key
Content-Type: application/octet-stream
[body: file stream]
```

### Delete a file
```http
DELETE /:bucket/:key
```

---

## curl Examples

```bash
# Health check
curl http://localhost:8080/health

# Upload a file
curl -X PUT http://localhost:8080/documents/tenant-a/invoice.pdf \
  -H "X-Buckie-Identity: erp-prod" \
  -H "X-Buckie-Secret: my-secret-password" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @invoice.pdf

# Upload using HTTP Basic Auth
curl -X PUT http://localhost:8080/documents/tenant-a/report.xlsx \
  -u "erp-prod:my-secret-password" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @report.xlsx

# Download a file
curl http://localhost:8080/documents/tenant-a/invoice.pdf \
  -H "X-Buckie-Identity: erp-prod" \
  -H "X-Buckie-Secret: my-secret-password" \
  -o invoice.pdf

# Download a thumbnail
curl "http://localhost:8080/documents/tenant-a/photo.jpg?w=300&h=300&fit=cover&format=webp" \
  -H "X-Buckie-Identity: erp-prod" \
  -H "X-Buckie-Secret: my-secret-password" \
  -o thumbnail.webp

# List a directory
curl http://localhost:8080/documents/tenant-a/ \
  -H "X-Buckie-Identity: erp-prod" \
  -H "X-Buckie-Secret: my-secret-password"

# List bucket contents (paginated)
curl "http://localhost:8080/documents?limit=50" \
  -H "X-Buckie-Identity: erp-prod" \
  -H "X-Buckie-Secret: my-secret-password"

# Next page using the cursor returned from the previous response
curl "http://localhost:8080/documents?limit=50&cursor=<cursor-value>" \
  -H "X-Buckie-Identity: erp-prod" \
  -H "X-Buckie-Secret: my-secret-password"

# Delete a file
curl -X DELETE http://localhost:8080/documents/tenant-a/invoice.pdf \
  -H "X-Buckie-Identity: erp-prod" \
  -H "X-Buckie-Secret: my-secret-password"
```

---

## Embedded Usage

### Minimal example

```js
// index.js  (type: "module")
import { startServer } from '@dynamia-tools/buckie'

startServer({
  host: process.env.BUCKIE_HOST ?? '0.0.0.0',
  port: parseInt(process.env.BUCKIE_PORT ?? '8080', 10),
}).catch((err) => {
  console.error('Fatal error during startup:', err)
  process.exit(1)
})
```

### Full programmatic setup

```js
import path from 'node:path'
import { createRuntime, createServer } from '@dynamia-tools/buckie'

const runtime = await createRuntime({
  dataDir:  path.join(process.cwd(), '.buckie'),
  host:     '0.0.0.0',
  port:     8080,
  logLevel: 'info',
})

const { config, bucketService, storageService, thumbnailService,
        identityService, operationalLogger } = runtime

// Create a local bucket (idempotent pattern)
if (!await bucketService.find('documents')) {
  await bucketService.create('documents', '/mnt/storage/documents')
}

// Create an SFTP bucket
if (!await bucketService.find('remote')) {
  await bucketService.create('remote', '/uploads', 'sftp', {
    host: 'storage.example.com',
    port: 22,
    username: 'deploy',
    privateKey: process.env.SFTP_PRIVATE_KEY,
  })
}

// Create an identity (idempotent pattern)
if (!await identityService.find('app-user')) {
  await identityService.create('app-user', process.env.APP_SECRET ?? 'changeme')
}

// Grant permissions
await identityService.grant('app-user', {
  bucket:      'documents',
  prefixes:    ['/'],
  permissions: ['read', 'write', 'delete'],
})

await bucketService.validateStartup()

const server = await createServer({
  config, bucketService, storageService,
  thumbnailService, identityService, operationalLogger,
})

process.on('SIGTERM', async () => { await server.close(); process.exit(0) })
process.on('SIGINT',  async () => { await server.close(); process.exit(0) })

await server.listen({ host: config.host, port: config.port })
```

### Available Exports

| Export | Description |
|---|---|
| `startServer(overrides?)` | One-call bootstrap: creates runtime + server + starts listening |
| `createRuntime(overrides?)` | Initialises services and data dirs, returns the runtime object |
| `createServer(runtime)` | Builds and returns the Fastify instance (does not call `.listen`) |
| `BucketService` | Manage bucket definitions |
| `IdentityService` | Manage identities and grants |
| `StorageService` | Low-level file upload / download / list |
| `LocalStorageProvider` | Local filesystem storage provider |
| `SftpStorageProvider` | SFTP storage provider |
| `StorageProviderRegistry` | Register custom storage backends |
| `ThumbnailService` | On-the-fly image thumbnails via Sharp |
| `OperationalLogger` | Structured JSONL access + error logs |

---

## Storage Backends

| Backend | Target key | Description |
|---|---|---|
| **Local FS** | `local` (default) | Files stored directly on the local filesystem. |
| **SFTP** | `sftp` | Files stored on a remote SFTP server. Uploads use a local staging area before being committed atomically to the remote path. |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BUCKIE_DATA_DIR` | `<cwd>/.buckie` | Where Buckie stores `config.json`, logs and cache |
| `BUCKIE_HOST` | `0.0.0.0` | Bind host |
| `BUCKIE_PORT` | `8080` | Bind port |
| `BUCKIE_LOG_LEVEL` | `info` | Pino log level (`trace` `debug` `info` `warn` `error`) |

---

## Data Directory Structure

```
.buckie/
 ├── config.json    # Single source of truth: buckets, identities and grants
 ├── logs/
 │   ├── access.log.jsonl
 │   └── error.log.jsonl
 └── cache/         # Thumbnail cache + SFTP staging area
```

### `config.json` structure

```json
{
  "buckets": [
    { "name": "documents", "path": "/mnt/storage/documents", "storage": "local" },
    { "name": "remote",    "path": "/uploads",               "storage": "sftp",
      "sftp": { "host": "storage.example.com", "port": 22, "username": "deploy" } }
  ],
  "identities": [
    {
      "identity": "erp-prod",
      "hashedSecret": "<bcrypt hash>",
      "grants": [
        { "bucket": "documents", "prefixes": ["/tenant-a/"], "permissions": ["read","write","delete"] }
      ]
    }
  ]
}
```

> **Docker tip:** mount or inject `config.json` at startup and Buckie will be fully configured with no CLI bootstrap needed.
> ```yaml
> volumes:
>   - ./buckie-config.json:/app/.buckie/config.json:ro
> ```

### Inside each bucket (local storage)

```
/path/to/bucket/
 ├── data/
 │    ├── my-photo.jpg          # Original file
 │    ├── 200x200/
 │    │    └── my-photo.jpg     # Thumbnail cached at 200×200
 │    └── 800x600/
 │         └── my-photo.jpg     # Thumbnail cached at 800×600
 └── .buckie/
      └── staging/              # Upload staging area (atomic commits)
```

---

## Technology Stack

- **Node.js 24** with TypeScript (strict mode)
- **Fastify** for high-throughput HTTP
- **Pino** for structured JSON logging
- **Sharp** for efficient thumbnail generation
- **bcrypt** for password hashing (cross-compatible with the PHP implementation)
- **ssh2-sftp-client** for SFTP backend
- **file-type** for MIME detection via magic bytes
- **Zod** for runtime schema validation

---

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Type-check only
npm run typecheck
```

---

## Security

- **Private by default** — every request requires authentication; there is no anonymous or public bucket support
- **bcrypt password hashing** — secrets are never stored in plain text; hashes are cross-compatible with the PHP implementation
- **Prefix-based authorization** — access can be restricted by bucket and path prefix
- **Path traversal protection** — canonical path validation is enforced on every request
- **Staging + atomic commits** — uploads are written to a staging area first to prevent partial reads

---

## Related Implementations

| Implementation | Repository | Best for |
|---|---|---|
| **Buckie PHP** | [github.com/dynamiatools/buckie-php](https://github.com/dynamiatools/buckie-php) | Shared hosting and standard PHP environments (Local FS, Apache, Nginx, FrankenPHP) |

---

## License

MIT © Dynamia Soluciones IT SAS

