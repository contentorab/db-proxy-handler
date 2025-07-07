/* eslint-disable */

const net = require("net");
const { spawn } = require("child_process");

const DEFAULT_PORT = "5432";

// Restart configuration - simple but effective
let restartCount = 0;
const MAX_RESTARTS = 50;
const RESTART_DELAY_BASE = 1000; // 1 second base delay
const MAX_RESTART_DELAY = 30000; // 30 second max delay

// Calculate restart delay with exponential backoff
function getRestartDelay() {
  const delay = Math.min(RESTART_DELAY_BASE * Math.pow(1.5, restartCount), MAX_RESTART_DELAY);
  return delay + Math.random() * 1000; // Add jitter
}

// Simple restart function
function restartProcess(reason = "Unknown error") {
  if (restartCount >= MAX_RESTARTS) {
    console.error(`CRITICAL: Max restarts (${MAX_RESTARTS}) reached. Exiting.`);
    process.exit(1);
  }

  restartCount++;
  const delay = getRestartDelay();

  console.error(`[RESTART ${restartCount}] Restarting due to: ${reason}`);
  console.error(`[RESTART ${restartCount}] Delay: ${Math.round(delay)}ms`);

  setTimeout(() => {
    // Spawn new process and exit current one
    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: "inherit",
      env: process.env,
    });
    child.unref();
    process.exit(0);
  }, delay);
}

// Configuration from environment variables
const TARGET_HOST = process.env.TARGET_HOST;
const TARGET_PORT = parseInt(process.env.TARGET_PORT || DEFAULT_PORT);
const LISTEN_PORT = parseInt(process.env.LISTEN_PORT || DEFAULT_PORT);

// Validate required environment variables
if (!TARGET_HOST) {
  console.error("ERROR: TARGET_HOST environment variable is required");
  // Give time for env vars to be set, then restart
  setTimeout(() => restartProcess("Missing TARGET_HOST"), 5000);
  return;
}

console.log("Starting PostgreSQL TCP Proxy with Auto-Restart");
console.log(`Listen: 0.0.0.0:${LISTEN_PORT}`);
console.log(`Target: ${TARGET_HOST}:${TARGET_PORT}`);
console.log(`Restart count: ${restartCount}`);

// Track active connections for monitoring
let activeConnections = 0;
let totalConnections = 0;
let consecutiveErrors = 0;
let lastActivity = Date.now();

// Track connection rates per IP address for rate limiting
const connectionRates = new Map();

// Create the TCP proxy server with unlimited connections
const server = net.createServer(
  {
    allowHalfOpen: false,
    pauseOnConnect: false, // Don't pause, handle immediately
  },
  (clientSocket) => {
    activeConnections++;
    totalConnections++;
    lastActivity = Date.now();

    const connectionId = totalConnections;
    const clientInfo = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    const clientIp = clientSocket.remoteAddress;
    const targetHost = TARGET_HOST;

    // Track connection rate per IP
    if (!connectionRates.has(clientIp)) {
      connectionRates.set(clientIp, []);
    }
    connectionRates.get(clientIp).push(Date.now());

    console.log(
      `[${connectionId}] New connection from ${clientInfo} -> ${targetHost}:${TARGET_PORT} (active: ${activeConnections})`
    );

    // Create connection to RDS proxy (let RDS proxy handle pooling)
    const serverSocket = net.createConnection({
      host: targetHost,
      port: TARGET_PORT,
      timeout: 30000, // 30 second connection timeout
    });

    // Optimize socket performance
    clientSocket.setKeepAlive(true, 60000);
    clientSocket.setNoDelay(true);
    clientSocket.setTimeout(0); // No timeout on client side

    // Handle successful connection to RDS proxy
    serverSocket.on("connect", () => {
      console.log(`[${connectionId}] Connected to RDS proxy ${targetHost}:${TARGET_PORT}`);
      consecutiveErrors = 0; // Reset error count on success

      // Optimize server socket performance
      serverSocket.setKeepAlive(true, 60000);
      serverSocket.setNoDelay(true);
      serverSocket.setTimeout(0); // No timeout on server side

      // Pipe data bidirectionally - let RDS proxy handle the rest
      clientSocket.pipe(serverSocket, { end: false });
      serverSocket.pipe(clientSocket, { end: false });
    });

    // Cleanup function
    function cleanup() {
      activeConnections = Math.max(0, activeConnections - 1);

      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
      if (!serverSocket.destroyed) {
        serverSocket.destroy();
      }

      console.log(`[${connectionId}] Connection cleaned up (active: ${activeConnections})`);
    }

    // Handle all disconnection scenarios
    clientSocket.on("close", () => cleanup());
    serverSocket.on("close", () => cleanup());
    clientSocket.on("end", () => !serverSocket.destroyed && serverSocket.end());
    serverSocket.on("end", () => !clientSocket.destroyed && clientSocket.end());

    // Handle errors gracefully
    clientSocket.on("error", (err) => {
      console.error(`[${connectionId}] Client error: ${err.message}`);
      cleanup();
    });

    serverSocket.on("error", (err) => {
      console.error(`[${connectionId}] RDS proxy error: ${err.message}`);
      consecutiveErrors++;

      // Restart if too many consecutive errors
      if (consecutiveErrors >= 10) {
        restartProcess(`Too many consecutive RDS errors: ${err.message}`);
        return;
      }

      cleanup();
    });

    serverSocket.on("timeout", () => {
      console.log(`[${connectionId}] Connection timeout to RDS proxy`);
      cleanup();
    });
  }
);

// Server configuration for high performance
server.maxConnections = 0; // Unlimited connections
server.timeout = 0; // No server timeout

// Handle server errors with restart
server.on("error", (err) => {
  console.error("Critical server error:", err);
  restartProcess(`Server error: ${err.message} (${err.code})`);
});

// Start listening with error handling
server.listen(LISTEN_PORT, "0.0.0.0", (err) => {
  if (err) {
    console.error("Failed to start server:", err);
    restartProcess(`Failed to bind to port ${LISTEN_PORT}`);
    return;
  }

  console.log(`TCP proxy server listening on port ${LISTEN_PORT} (unlimited connections)`);
  restartCount = 0; // Reset restart count on successful start
});

// Graceful shutdown
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

function gracefulShutdown() {
  console.log("\nShutting down gracefully...");

  server.close(() => {
    console.log("Server stopped accepting new connections");
    console.log(`Waiting for ${activeConnections} active connections to close...`);

    // Check every second if all connections are closed
    const checkInterval = setInterval(() => {
      if (activeConnections === 0) {
        clearInterval(checkInterval);
        console.log("All connections closed. Shutdown complete.");
        process.exit(0);
      }
    }, 1000);

    // Force shutdown after 30 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      console.log("Force shutdown after 30 seconds");
      process.exit(0);
    }, 30000);
  });
}

// Enhanced health check with restart capability
const http = require("http");
const healthServer = http.createServer((req, res) => {
  const url = req.url;

  if (url === "/ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("pong");
  } else if (url === "/health") {
    const timeSinceActivity = Date.now() - lastActivity;
    const isHealthy = timeSinceActivity < 300000; // 5 minutes

    res.writeHead(isHealthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: isHealthy ? "healthy" : "unhealthy",
        activeConnections: activeConnections,
        totalConnections: totalConnections,
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage(),
        pid: process.pid,
        restartCount: restartCount,
        consecutiveErrors: consecutiveErrors,
        timeSinceActivity: timeSinceActivity,
      })
    );
  } else if (url === "/metrics") {
    // Prometheus-style metrics
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`# HELP tcp_proxy_active_connections Number of active connections
# TYPE tcp_proxy_active_connections gauge
tcp_proxy_active_connections ${activeConnections}

# HELP tcp_proxy_total_connections Total number of connections handled
# TYPE tcp_proxy_total_connections counter
tcp_proxy_total_connections ${totalConnections}

# HELP tcp_proxy_uptime_seconds Uptime in seconds
# TYPE tcp_proxy_uptime_seconds gauge
tcp_proxy_uptime_seconds ${process.uptime()}

# HELP tcp_proxy_restart_count Number of restarts
# TYPE tcp_proxy_restart_count counter
tcp_proxy_restart_count ${restartCount}

# HELP tcp_proxy_consecutive_errors Number of consecutive errors
# TYPE tcp_proxy_consecutive_errors gauge
tcp_proxy_consecutive_errors ${consecutiveErrors}
`);
  }
});

// Don't restart for health server errors, just log them
healthServer.on("error", (err) => {
  console.error("Health server error (non-critical):", err);
});

healthServer.listen(5454, () => {
  console.log("Health check server listening on port 5454");
  console.log("Endpoints: /health, /metrics");
});

// Handle uncaught exceptions and rejections
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  restartProcess(`Uncaught exception: ${err.message}`);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
  restartProcess(`Unhandled rejection: ${reason}`);
});

// Health monitoring - restart if unhealthy for too long
setInterval(() => {
  const timeSinceActivity = Date.now() - lastActivity;
  const memUsage = process.memoryUsage();
  const memMB = Math.round(memUsage.rss / 1024 / 1024);

  // Restart if no activity for 15 minutes and no connections
  if (timeSinceActivity > 900000 && activeConnections === 0) {
    restartProcess("Health check: No activity for 15 minutes");
    return;
  }

  // Restart if memory usage is too high (>1.5GB)
  if (memMB > 1536) {
    restartProcess(`High memory usage: ${memMB}MB`);
    return;
  }

  console.log(
    `Health: ${activeConnections} active, ${totalConnections} total | Memory: ${memMB}MB | Errors: ${consecutiveErrors} | Restarts: ${restartCount}`
  );
}, 60000); // Check every minute

// Connection stats logging
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(
    `Stats: ${activeConnections} active, ${totalConnections} total connections | Memory: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS`
  );
}, 30000);

// Clean up connection rate tracking every 5 minutes
setInterval(() => {
  const now = Date.now();
  const windowMs = 60000;

  for (const [ip, connections] of connectionRates.entries()) {
    // Remove old connections
    while (connections.length > 0 && connections[0] < now - windowMs) {
      connections.shift();
    }

    // Remove IP if no recent connections
    if (connections.length === 0) {
      connectionRates.delete(ip);
    }
  }
}, 300000);
