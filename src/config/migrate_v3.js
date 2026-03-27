const { pool } = require('./database');

const migrate_v3 = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running v3 migrations (IP login tracking + password policy)...');
    await client.query('BEGIN');

    // Add last_login_ip to users
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_ip INET`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS previous_login TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS previous_login_ip INET`);

    // Index for fast IP lookups on users
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_last_login_ip ON users(last_login_ip)`);

    // login_sessions table — full history per user
    await client.query(`
      CREATE TABLE IF NOT EXISTS login_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip_address INET NOT NULL,
        user_agent TEXT,
        login_at TIMESTAMPTZ DEFAULT NOW(),
        logout_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT true,
        is_suspicious BOOLEAN DEFAULT false,
        country VARCHAR(100),
        city VARCHAR(100),
        device_type VARCHAR(50),
        browser VARCHAR(100)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_ip ON login_sessions(ip_address)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_login ON login_sessions(login_at DESC)`);

    await client.query('COMMIT');
    console.log('✅ V3 migrations completed!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ V3 migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v3().catch(console.error);
