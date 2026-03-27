require('dotenv').config();
const { pool } = require('./database');

const migrate_v6 = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running v6 migrations (Tasks + Notifications upgrade)...');
    await client.query('BEGIN');

    /* ── Enhance notifications table ─────────────────────────────── */
    await client.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_type VARCHAR(60)`);
    await client.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS entity_id   UUID`);
    await client.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_id    UUID REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at     TIMESTAMPTZ`);

    /* ── Enhance tasks table ──────────────────────────────────────── */
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS company_id   UUID REFERENCES companies(id) ON DELETE SET NULL`).catch(()=>{});
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS watcher_ids  UUID[] DEFAULT '{}'`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments  JSONB  DEFAULT '[]'`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES users(id) ON DELETE SET NULL`);

    /* ── Task comments table ──────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_comments (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        comment    TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── Indexes ──────────────────────────────────────────────────── */
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned  ON tasks(assigned_to)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_by ON tasks(assigned_by)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_due       ON tasks(due_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notif_user      ON notifications(user_id, is_read, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notif_entity    ON notifications(entity_type, entity_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_comments_task   ON task_comments(task_id)`);

    /* ── Seed tasks module ────────────────────────────────────────── */
    await client.query(`
      INSERT INTO modules (name, slug, icon, sort_order, category, is_active)
      VALUES ('Tasks', 'tasks', 'CheckSquare', 15, 'work', true)
      ON CONFLICT (name) DO UPDATE SET slug=EXCLUDED.slug, icon=EXCLUDED.icon
    `);

    /* ── Grant permissions on tasks module ───────────────────────── */
    await client.query(`
      INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
      SELECT r.id, m.id, pt.perm::permission_type, true
      FROM roles r
      CROSS JOIN modules m
      CROSS JOIN (VALUES ('create'),('read'),('update'),('delete'),('manage')) pt(perm)
      WHERE m.slug = 'tasks'
      ON CONFLICT (role_id, module_id, permission_type) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅ V6 done — Tasks + Notifications upgraded\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ V6 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v6();
