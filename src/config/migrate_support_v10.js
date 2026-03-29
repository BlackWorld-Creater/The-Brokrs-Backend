/**
 * migrate_support_v10.js
 * Migration for the Enhanced Customer Support System.
 * Creates support_tickets and support_messages tables.
 */
const { pool } = require('./database');

const migrateSupport = async () => {
  const client = await pool.connect();
  try {
    console.log('\n🚀 Starting Support System Migration (v10)...');
    await client.query('BEGIN');

    /* ── 1. ADD SUPPORT ROLE ─────────────────────────────────────── */
    await client.query(`
      INSERT INTO roles (name, slug, description, is_system)
      VALUES ('Support Agent', 'support', 'Dedicated customer support access', false)
      ON CONFLICT (slug) DO NOTHING
    `);
    console.log('✅ Support role ensured');

    /* ── 2. CREATE SUPPORT_TICKETS ────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        guest_name VARCHAR(100),
        guest_email VARCHAR(255),
        category VARCHAR(100) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(20) DEFAULT 'open', -- open, in-progress, resolved
        mode VARCHAR(20) DEFAULT 'bot',    -- bot, agent
        assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ support_tickets table created');

    /* ── 3. CREATE SUPPORT_MESSAGES ───────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        ticket_id UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
        sender_type VARCHAR(20) NOT NULL, -- bot, user, agent
        text TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ support_messages table created');

    /* ── 4. INDEXES ──────────────────────────────────────────────── */
    await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_user ON support_tickets(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id)`);

    /* ── 5. UPDATE TRIGGER ────────────────────────────────────────── */
    await client.query(`
      DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;
      CREATE TRIGGER trg_support_tickets_updated_at
        BEFORE UPDATE ON support_tickets
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    await client.query('COMMIT');
    console.log('\n✅ Support Migration (v10) Completed Successfully!\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Support Migration Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrateSupport();
