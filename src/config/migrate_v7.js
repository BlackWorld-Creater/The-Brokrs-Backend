require('dotenv').config();
const { pool } = require('./database');

const migrate_v7 = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running v7 migrations (User Dashboard + Email Settings)...');
    await client.query('BEGIN');

    /* ── Email settings in settings table ───────────────────────── */
    const emailSettings = [
      { key: 'smtp_host',           value: '',              type: 'string',  group: 'email', desc: 'SMTP server hostname (e.g. smtp.gmail.com)' },
      { key: 'smtp_port',           value: '587',           type: 'number',  group: 'email', desc: 'SMTP port (587 for TLS, 465 for SSL, 25 for plain)' },
      { key: 'smtp_secure',         value: 'false',         type: 'boolean', group: 'email', desc: 'Use SSL/TLS (true for port 465)' },
      { key: 'smtp_user',           value: '',              type: 'string',  group: 'email', desc: 'SMTP authentication username / email' },
      { key: 'smtp_password',       value: '',              type: 'password',group: 'email', desc: 'SMTP authentication password or app password' },
      { key: 'smtp_from_name',      value: 'Admin Panel',   type: 'string',  group: 'email', desc: 'Sender display name shown in recipient inbox' },
      { key: 'smtp_from_email',     value: '',              type: 'string',  group: 'email', desc: 'Sender email address (must be authorised on SMTP)' },
      { key: 'smtp_reply_to',       value: '',              type: 'string',  group: 'email', desc: 'Reply-To address (leave blank to use from email)' },
      { key: 'email_notifications_enabled', value: 'true',  type: 'boolean', group: 'email', desc: 'Send email notifications for tasks, leave, etc.' },
      { key: 'email_task_assigned',         value: 'true',  type: 'boolean', group: 'email', desc: 'Email when a task is assigned to a user' },
      { key: 'email_leave_request',         value: 'true',  type: 'boolean', group: 'email', desc: 'Email when a leave request is submitted' },
      { key: 'email_leave_approved',        value: 'true',  type: 'boolean', group: 'email', desc: 'Email when a leave request is approved/rejected' },
      { key: 'email_welcome_user',          value: 'true',  type: 'boolean', group: 'email', desc: 'Send welcome email when a new user is created' },
    ];

    for (const s of emailSettings) {
      await client.query(
        `INSERT INTO settings (key, value, type, group_name, description, is_public)
         VALUES ($1,$2,$3,$4,$5,false)
         ON CONFLICT (key) DO UPDATE SET description=$5`,
        [s.key, s.value, s.type, s.group, s.desc]
      );
    }

    /* ── User dashboard widgets prefs table ──────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        theme      VARCHAR(20) DEFAULT 'dark',
        dashboard_widgets JSONB DEFAULT '["tasks","attendance","leave","notifications","quick_actions","activity"]',
        notifications_email BOOLEAN DEFAULT true,
        notifications_push  BOOLEAN DEFAULT true,
        locale     VARCHAR(10) DEFAULT 'en',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── Email logs table ────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        to_email    VARCHAR(255) NOT NULL,
        to_name     VARCHAR(200),
        subject     VARCHAR(500) NOT NULL,
        template    VARCHAR(100),
        status      VARCHAR(20) DEFAULT 'sent',
        error       TEXT,
        sent_by     UUID REFERENCES users(id) ON DELETE SET NULL,
        sent_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_email_logs_sent ON email_logs(sent_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_prefs_user ON user_preferences(user_id)`);

    await client.query('COMMIT');
    console.log('✅ V7 migrations complete — Email Settings + User Dashboard tables ready\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ V7 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v7();
