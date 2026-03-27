/**
 * Global Configuration Handler
 * Loads and validates environment variables.
 */
require('dotenv').config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,
  
  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME     || 'erp_admin_db',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres123',
  },

  jwt: {
    secret:           process.env.JWT_SECRET           || 'change_this_to_a_secure_secret_min_32_chars',
    refreshSecret:    process.env.JWT_REFRESH_SECRET    || 'change_this_refresh_secret_min_32_chars',
    expiresIn:        process.env.JWT_EXPIRES_IN        || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max:      parseInt(process.env.RATE_LIMIT_MAX, 10)      || 500,
  }
};

module.exports = config;
