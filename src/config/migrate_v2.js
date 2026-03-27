const { pool } = require('./database');

const migrate_v2 = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running v2 migrations...');
    await client.query('BEGIN');

    // Verticals table
    await client.query(`
      CREATE TABLE IF NOT EXISTS verticals (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(150) NOT NULL UNIQUE,
        slug VARCHAR(150) NOT NULL UNIQUE,
        description TEXT,
        icon VARCHAR(60),
        color VARCHAR(20) DEFAULT '#6366f1',
        is_active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Vertical members
    await client.query(`
      CREATE TABLE IF NOT EXISTS vertical_members (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(60) DEFAULT 'member',
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(vertical_id, user_id)
      )
    `);

    // System modules management (extend the modules table)
    await client.query(`ALTER TABLE modules ADD COLUMN IF NOT EXISTS version VARCHAR(20) DEFAULT '1.0.0'`);
    await client.query(`ALTER TABLE modules ADD COLUMN IF NOT EXISTS category VARCHAR(60) DEFAULT 'core'`);
    await client.query(`ALTER TABLE modules ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'`);
    await client.query(`ALTER TABLE modules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    // IP Tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ip_tracking (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        ip_address INET NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        event_type VARCHAR(60) NOT NULL DEFAULT 'request',
        path VARCHAR(500),
        method VARCHAR(10),
        status_code INTEGER,
        user_agent TEXT,
        country VARCHAR(100),
        city VARCHAR(100),
        region VARCHAR(100),
        isp VARCHAR(200),
        latitude DECIMAL(9,6),
        longitude DECIMAL(9,6),
        is_blocked BOOLEAN DEFAULT false,
        block_reason TEXT,
        risk_score INTEGER DEFAULT 0,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Blocked IPs
    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_ips (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        ip_address INET NOT NULL UNIQUE,
        reason TEXT,
        blocked_by UUID REFERENCES users(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ,
        is_permanent BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for IP tracking
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ip_tracking_ip ON ip_tracking(ip_address)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ip_tracking_user ON ip_tracking(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ip_tracking_created ON ip_tracking(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ip_tracking_event ON ip_tracking(event_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip ON blocked_ips(ip_address)`);

    // Trigger for modules updated_at
    await client.query(`
      DROP TRIGGER IF EXISTS update_modules_v2_updated_at ON modules;
      CREATE TRIGGER update_modules_v2_updated_at
        BEFORE UPDATE ON modules
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `).catch(() => {});

    await client.query(`
      DROP TRIGGER IF EXISTS update_verticals_updated_at ON verticals;
      CREATE TRIGGER update_verticals_updated_at
        BEFORE UPDATE ON verticals
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    // Seed verticals module in modules table
    await client.query(`
      INSERT INTO modules (name, slug, icon, sort_order, category)
      VALUES 
        ('Verticals', 'verticals', 'Layers', 11, 'management'),
        ('Modules Manager', 'modules', 'Grid3X3', 12, 'system'),
        ('IP Tracking', 'ip-tracking', 'Globe', 13, 'security')
      ON CONFLICT (slug) DO NOTHING
    `);

    // Grant super-admin all permissions for new modules
    await client.query(`
      INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
      SELECT r.id, m.id, pt.perm, true
      FROM roles r
      CROSS JOIN modules m
      CROSS JOIN (VALUES ('create'),('read'),('update'),('delete'),('export'),('import'),('approve'),('manage')) AS pt(perm)
      WHERE r.slug = 'super-admin'
      AND m.slug IN ('verticals', 'modules', 'ip-tracking')
      ON CONFLICT (role_id, module_id, permission_type) DO NOTHING
    `);

    // Seed sample verticals
    await client.query(`
      INSERT INTO verticals (name, slug, description, icon, color, sort_order)
      VALUES 
        ('Technology', 'technology', 'Software & tech division', 'Code', '#6366f1', 1),
        ('Operations', 'operations', 'Core operations & logistics', 'Settings', '#22c55e', 2),
        ('Finance', 'finance', 'Finance & accounting unit', 'DollarSign', '#f59e0b', 3),
        ('Marketing', 'marketing', 'Marketing & brand division', 'TrendingUp', '#ec4899', 4),
        ('Human Resources', 'human-resources', 'HR & people operations', 'Users', '#06b6d4', 5)
      ON CONFLICT (slug) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅ V2 migrations completed!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ V2 migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v2().catch(console.error);
