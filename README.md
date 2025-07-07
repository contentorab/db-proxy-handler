# db-proxy-handler

TARGET_HOST=your-rds-proxy-endpoint.proxy-xxxxx.region.rds.amazonaws.com
TARGET_PORT=5432 # Optional, defaults to 5432
LISTEN_PORT=5432 # Optional, defaults to 5432

### Run with Docker Compose (Recommended)

```bash
# Set your RDS proxy endpoint
export DB_PROXY_ENDPOINT=your-rds-proxy-endpoint.proxy-xxxxx.region.rds.amazonaws.com

# Start the proxy
docker-compose up -d

# View logs
docker-compose logs -f proxy-server
```

### Run with Node.js

```bash
# Install dependencies (none required - uses Node.js built-ins)
# Set environment variables
export TARGET_HOST=your-rds-proxy-endpoint.proxy-xxxxx.region.rds.amazonaws.com

# Start the server
node server.js
```

## Ports

- **5432**: Main proxy port (PostgreSQL protocol)
- **5454**: Health check and metrics port

## Health Monitoring

### Health Check Endpoints

**Basic Health Check**

```bash
curl http://localhost:5454/health
```

**Simple Ping**

```bash
curl http://localhost:5454/ping
```

**Prometheus Metrics**

```bash
curl http://localhost:5454/metrics
```

### Health Response Example

```json
{
  "status": "healthy",
  "activeConnections": 5,
  "totalConnections": 1247,
  "uptime": 3600,
  "memoryUsage": {...},
  "pid": 1234,
  "restartCount": 0,
  "consecutiveErrors": 0,
  "timeSinceActivity": 1500
}
```

## Features

### Auto-Restart Capability

- **Exponential backoff**: Delays between restarts increase progressively
- **Max restart limit**: Prevents infinite restart loops
- **Smart triggers**: Restarts on memory limits, consecutive errors, or inactivity
- **Graceful shutdown**: Waits for active connections to close

### Connection Management

- **Unlimited connections**: No artificial connection limits
- **Connection tracking**: Monitors active and total connections
- **Rate limiting awareness**: Tracks connection rates per IP
- **Optimized performance**: TCP_NODELAY and keep-alive enabled

### Error Handling

- **Graceful error recovery**: Handles client and server errors
- **Connection cleanup**: Properly closes connections on errors
- **Health monitoring**: Continuous health checks and metrics

## AWS Deployment

This server is designed to run on AWS EC2 instances with automatic setup:

1. **Instance Setup**: Automatically installs Docker, nginx, and certbot
2. **SSL Certificates**: Auto-generates Let's Encrypt certificates
3. **Auto-start**: Configured to start on boot via cron
4. **Reverse Proxy**: nginx forwards health check traffic
5. **Monitoring**: Health endpoints exposed for load balancer checks

### Typical Architecture

Internet → Load Balancer → EC2 Instance → DB Proxy Handler → RDS Proxy → RDS Cluster