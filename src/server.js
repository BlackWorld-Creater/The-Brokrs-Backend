const config = require('./config/env');
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const path    = require('path');

const routes       = require('./routes');
const { initSocket } = require('./utils/socketServer');
const { swaggerUi, swaggerDocs } = require('./config/swagger');


const app    = express();
const server = http.createServer(app);
const PORT   = config.port;

// ─── Security ────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: config.cors.origin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Rate Limiting
app.use('/api/', rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
}));

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, message: 'Too many login attempts.' },
}));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Logging ──────────────────────────────────────────────────────────────────
if (config.env !== 'test') {
  app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
}

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ─── Swagger Documentation ───────────────────────────────────────────────────
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', routes);


// ─── Health Check ─────────────────────────────────────────────────────────────
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health Check
 *     tags: [Utility]
 *     responses:
 *       200:
 *         description: API is healthy
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    environment: config.env,
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.statusCode || 500).json({
    success: false,
    message: config.env === 'production' ? 'Internal server error' : err.message,
    ...(config.env === 'development' && { stack: err.stack }),
  });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = initSocket(server);
app.set('io', io);   // make io accessible in controllers if needed

// ─── Start ────────────────────────────────────────────────────────────────────
if (config.env !== 'test') {
  server.listen(PORT, () => {
    console.log(`\n🚀 Admin Panel API  →  http://localhost:${PORT}`);
    console.log(`💬 Chat WebSocket  →  ws://localhost:${PORT}`);
    console.log(`💊 Health check    →  http://localhost:${PORT}/health`);
    console.log(`🌍 Environment     →  ${config.env}\n`);
  });
}



process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

module.exports = app;
