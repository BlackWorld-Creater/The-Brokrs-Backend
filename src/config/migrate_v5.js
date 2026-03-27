require('dotenv').config();
const { pool } = require('./database');

const migrate_v5 = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running v5 migrations (Cascading Sync - company/site refs everywhere)...');
    await client.query('BEGIN');

    /* ── Guard: v4 must have run first ───────────────────────────── */
    const [companiesExist, sitesExist] = await Promise.all([
      client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='companies'`),
      client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='sites'`),
    ]);
    if (!companiesExist.rows.length || !sitesExist.rows.length) {
      throw new Error(
        'Companies or Sites tables do not exist.\n' +
        'Run migrate:v4 first:  npm run migrate:v4'
      );
    }

    /* ── Add company_id + site_id to users ───────────────────────── */
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS site_id    UUID REFERENCES sites(id)    ON DELETE SET NULL`);

    /* ── Add company_id + site_id to departments ──────────────────── */
    await client.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS site_id    UUID REFERENCES sites(id)    ON DELETE SET NULL`);

    /* ── Add company_id to projects ───────────────────────────────── */
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS site_id    UUID REFERENCES sites(id)    ON DELETE SET NULL`);

    /* ── Entity change events table ───────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS entity_change_events (
        id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        entity_type    VARCHAR(60) NOT NULL,
        entity_id      UUID NOT NULL,
        event_type     VARCHAR(30) NOT NULL DEFAULT 'update',
        changed_fields JSONB DEFAULT '{}',
        old_values     JSONB,
        new_values     JSONB,
        changed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ece_entity  ON entity_change_events(entity_type, entity_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ece_created ON entity_change_events(created_at DESC)`);

    /* ── Settings sync from default company (safe — skips if no data) */
    try {
      await client.query(`
        UPDATE settings s SET value = c.name
        FROM companies c WHERE s.key = 'company_name' AND c.is_default = true
      `);
      await client.query(`
        UPDATE settings s SET value = c.email
        FROM companies c WHERE s.key = 'company_email' AND c.is_default = true AND c.email IS NOT NULL
      `);
      await client.query(`
        UPDATE settings s SET value = c.phone
        FROM companies c WHERE s.key = 'company_phone' AND c.is_default = true AND c.phone IS NOT NULL
      `);
      console.log('   ✓ Settings synced from default company');
    } catch (e) {
      console.log('   ⚠ Settings sync skipped:', e.message);
    }

    /* ── Assign existing users to default company ─────────────────── */
    const userUpdateRes = await client.query(`
      UPDATE users
      SET company_id = (SELECT id FROM companies WHERE is_default = true LIMIT 1)
      WHERE company_id IS NULL
        AND (SELECT COUNT(*) FROM companies WHERE is_default = true) > 0
    `);
    console.log(`   ✓ ${userUpdateRes.rowCount} user(s) assigned to default company`);

    /* ── Assign existing departments to default company ───────────── */
    const deptUpdateRes = await client.query(`
      UPDATE departments
      SET company_id = (SELECT id FROM companies WHERE is_default = true LIMIT 1)
      WHERE company_id IS NULL
        AND (SELECT COUNT(*) FROM companies WHERE is_default = true) > 0
    `);
    console.log(`   ✓ ${deptUpdateRes.rowCount} department(s) assigned to default company`);

    /* ── Indexes ──────────────────────────────────────────────────── */
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_site    ON users(site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_depts_company ON departments(company_id)`);

    await client.query('COMMIT');
    console.log('\n✅ V5 migrations completed!');
    console.log('   - users.company_id, users.site_id added');
    console.log('   - departments.company_id, departments.site_id added');
    console.log('   - projects.company_id, projects.site_id added');
    console.log('   - entity_change_events table created');
    console.log('   - Existing data assigned to default company\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ V5 migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v5();
