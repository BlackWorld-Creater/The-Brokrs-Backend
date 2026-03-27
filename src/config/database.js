const { Pool } = require('pg');
const config = require('./env');

/* ── Validate required config before connecting ─────────────────── */
if (!config.db.password) {
  console.error('\n❌ ERROR: DB_PASSWORD is not set in your .env file!');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Common for Render/Heroku
  ...(!process.env.DATABASE_URL && {
    host:     config.db.host,
    port:     config.db.port,
    database: config.db.database,
    user:     config.db.user,
    password: String(config.db.password),
  }),
  max: 20,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
  ssl: (config.env === 'production' || !!process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
});


pool.on('connect', (client) => {
  if (config.env !== 'test') {
    console.log('✅ Connected to PostgreSQL');
  }
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (config.env === 'development') {
      console.log('Query executed', { text: text.substring(0, 80), duration, rows: res.rowCount });
    }
    return res;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  }
};

const getClient = async () => {
  const client = await pool.connect();
  const originalQuery = client.query.bind(client);
  const release = client.release.bind(client);

  const timeout = setTimeout(() => {
    console.error('Client checkout has been held for 5 seconds');
  }, 5000);

  client.query = (...args) => {
    client.lastQuery = args;
    return originalQuery(...args);
  };

  client.release = () => {
    clearTimeout(timeout);
    client.query = originalQuery;
    client.release = release;
    return release();
  };

  return client;
};

const transaction = async (callback) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, transaction, pool };

