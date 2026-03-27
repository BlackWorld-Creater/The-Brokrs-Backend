require('dotenv').config();
const { pool } = require('./database');

const migrate_v9 = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running v9 — Internal Chat System...');
    await client.query('BEGIN');

    /* ── Chat Rooms (direct + group) ─────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        type        VARCHAR(20) NOT NULL DEFAULT 'direct', -- direct | group | announcement
        name        VARCHAR(200),          -- null for direct chats
        description TEXT,
        avatar_url  VARCHAR(500),
        created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        is_active   BOOLEAN DEFAULT true,
        last_message_at TIMESTAMPTZ,
        last_message    TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── Room Members ────────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_members (
        id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        room_id   UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role      VARCHAR(20) DEFAULT 'member', -- member | admin | owner
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        last_read_at TIMESTAMPTZ DEFAULT NOW(),
        is_muted  BOOLEAN DEFAULT false,
        UNIQUE(room_id, user_id)
      )
    `);

    /* ── Messages ────────────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        room_id     UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content     TEXT NOT NULL,
        type        VARCHAR(20) DEFAULT 'text', -- text | image | file | system
        reply_to_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
        file_url    VARCHAR(500),
        file_name   VARCHAR(255),
        file_size   INTEGER,
        is_edited   BOOLEAN DEFAULT false,
        is_deleted  BOOLEAN DEFAULT false,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── Message Reactions ───────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_reactions (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji      VARCHAR(10) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(message_id, user_id, emoji)
      )
    `);

    /* ── Indexes ─────────────────────────────────────────────────── */
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_user   ON chat_members(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_members_room   ON chat_members(room_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_room  ON chat_messages(room_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_id)`);

    /* ── Seed chat module ────────────────────────────────────────── */
    await client.query(`
      INSERT INTO modules (name, slug, icon, sort_order, category, is_active)
      VALUES ('Internal Chat', 'chat', 'MessageSquare', 16, 'work', true)
      ON CONFLICT (name) DO UPDATE SET slug=EXCLUDED.slug, icon=EXCLUDED.icon
    `);

    /* ── Grant permissions ───────────────────────────────────────── */
    await client.query(`
      INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
      SELECT r.id, m.id, pt.perm::permission_type, true
      FROM roles r
      CROSS JOIN modules m
      CROSS JOIN (VALUES ('create'),('read'),('update'),('delete')) pt(perm)
      WHERE m.slug = 'chat'
      ON CONFLICT (role_id, module_id, permission_type) DO NOTHING
    `);

    /* ── Create "All Staff" room + add all users in one CTE ─────── */
    await client.query(`
      WITH admin_user AS (
        SELECT id FROM users ORDER BY created_at ASC LIMIT 1
      ),
      new_room AS (
        INSERT INTO chat_rooms (type, name, description, created_by)
        SELECT 'announcement', 'All Staff', 'Company-wide announcements', id
        FROM admin_user
        ON CONFLICT DO NOTHING
        RETURNING id
      ),
      existing_room AS (
        SELECT id FROM chat_rooms WHERE name = 'All Staff' AND type = 'announcement' LIMIT 1
      ),
      room AS (
        SELECT id FROM new_room
        UNION ALL
        SELECT id FROM existing_room
        LIMIT 1
      )
      INSERT INTO chat_members (room_id, user_id, role)
      SELECT r.id, u.id,
        CASE WHEN u.id = (SELECT id FROM admin_user) THEN 'owner' ELSE 'member' END
      FROM room r
      CROSS JOIN users u
      WHERE u.status = 'active'
      ON CONFLICT (room_id, user_id) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅ V9 done — Internal Chat System ready\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ V9 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v9();
