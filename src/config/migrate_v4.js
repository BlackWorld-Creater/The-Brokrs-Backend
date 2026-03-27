require('dotenv').config();
const { pool } = require('./database');

const migrate_v4 = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Running v4 migrations (Company Master, Site Master, Web Services)...');
    await client.query('BEGIN');

    /* ── COMPANY MASTER ─────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        code          VARCHAR(30) NOT NULL UNIQUE,
        name          VARCHAR(255) NOT NULL,
        legal_name    VARCHAR(255),
        type          VARCHAR(60)  DEFAULT 'private_limited',
        industry      VARCHAR(100),
        logo_url      VARCHAR(500),
        website       VARCHAR(300),
        email         VARCHAR(255),
        phone         VARCHAR(30),
        fax           VARCHAR(30),
        address_line1 VARCHAR(300),
        address_line2 VARCHAR(300),
        city          VARCHAR(100),
        state         VARCHAR(100),
        country       VARCHAR(100) DEFAULT 'India',
        pincode       VARCHAR(20),
        pan_number    VARCHAR(20),
        gstin         VARCHAR(20),
        tan_number    VARCHAR(20),
        cin_number    VARCHAR(25),
        reg_number    VARCHAR(50),
        currency      VARCHAR(10)  DEFAULT 'INR',
        fiscal_year_start VARCHAR(5) DEFAULT '04-01',
        timezone      VARCHAR(60)  DEFAULT 'Asia/Kolkata',
        date_format   VARCHAR(30)  DEFAULT 'DD/MM/YYYY',
        is_active     BOOLEAN DEFAULT true,
        is_default    BOOLEAN DEFAULT false,
        bank_name     VARCHAR(150),
        bank_account  VARCHAR(50),
        bank_ifsc     VARCHAR(20),
        bank_branch   VARCHAR(150),
        description   TEXT,
        notes         TEXT,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── SITE MASTER ─────────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        code          VARCHAR(30) NOT NULL,
        name          VARCHAR(255) NOT NULL,
        type          VARCHAR(60)  DEFAULT 'branch',
        email         VARCHAR(255),
        phone         VARCHAR(30),
        fax           VARCHAR(30),
        address_line1 VARCHAR(300),
        address_line2 VARCHAR(300),
        city          VARCHAR(100),
        state         VARCHAR(100),
        country       VARCHAR(100) DEFAULT 'India',
        pincode       VARCHAR(20),
        gstin         VARCHAR(20),
        latitude      DECIMAL(10,7),
        longitude     DECIMAL(10,7),
        timezone      VARCHAR(60)  DEFAULT 'Asia/Kolkata',
        is_active     BOOLEAN DEFAULT true,
        is_hq         BOOLEAN DEFAULT false,
        manager_id    UUID REFERENCES users(id) ON DELETE SET NULL,
        capacity      INTEGER,
        area_sqft     DECIMAL(10,2),
        description   TEXT,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_id, code)
      )
    `);

    /* ── WEB SERVICES ────────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS web_services (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name          VARCHAR(150) NOT NULL,
        slug          VARCHAR(150) NOT NULL UNIQUE,
        description   TEXT,
        base_url      VARCHAR(500) NOT NULL,
        version       VARCHAR(20)  DEFAULT 'v1',
        auth_type     VARCHAR(30)  DEFAULT 'api_key',
        status        VARCHAR(20)  DEFAULT 'active',
        environment   VARCHAR(20)  DEFAULT 'production',
        timeout_ms    INTEGER      DEFAULT 30000,
        retry_count   INTEGER      DEFAULT 3,
        rate_limit    INTEGER      DEFAULT 100,
        tags          TEXT[]       DEFAULT '{}',
        is_active     BOOLEAN DEFAULT true,
        last_checked  TIMESTAMPTZ,
        last_status   VARCHAR(20),
        uptime_pct    DECIMAL(5,2) DEFAULT 100.00,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── WEB SERVICE ENDPOINTS ───────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS ws_endpoints (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id    UUID NOT NULL REFERENCES web_services(id) ON DELETE CASCADE,
        name          VARCHAR(150) NOT NULL,
        method        VARCHAR(10)  DEFAULT 'GET',
        path          VARCHAR(500) NOT NULL,
        description   TEXT,
        auth_required BOOLEAN DEFAULT true,
        is_active     BOOLEAN DEFAULT true,
        request_schema  JSONB DEFAULT '{}',
        response_schema JSONB DEFAULT '{}',
        headers       JSONB DEFAULT '{}',
        sample_payload JSONB,
        tags          TEXT[]  DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── WEB SERVICE API KEYS ────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS ws_api_keys (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id    UUID NOT NULL REFERENCES web_services(id) ON DELETE CASCADE,
        name          VARCHAR(150) NOT NULL,
        key_hash      VARCHAR(255) NOT NULL UNIQUE,
        key_prefix    VARCHAR(20),
        scopes        TEXT[]  DEFAULT '{}',
        expires_at    TIMESTAMPTZ,
        is_active     BOOLEAN DEFAULT true,
        last_used     TIMESTAMPTZ,
        usage_count   BIGINT DEFAULT 0,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── WEB SERVICE LOGS ────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS ws_logs (
        id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        service_id    UUID NOT NULL REFERENCES web_services(id) ON DELETE CASCADE,
        endpoint_id   UUID REFERENCES ws_endpoints(id) ON DELETE SET NULL,
        method        VARCHAR(10),
        path          VARCHAR(500),
        status_code   INTEGER,
        response_time_ms INTEGER,
        request_ip    INET,
        user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
        error_message TEXT,
        metadata      JSONB,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* ── Indexes ─────────────────────────────────────────────────── */
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sites_company ON sites(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ws_endpoints_svc ON ws_endpoints(service_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ws_logs_svc ON ws_logs(service_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ws_logs_created ON ws_logs(created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ws_apikeys_svc ON ws_api_keys(service_id)`);

    /* ── Triggers ────────────────────────────────────────────────── */
    for (const t of ['companies','sites','web_services','ws_endpoints']) {
      await client.query(`
        DROP TRIGGER IF EXISTS trg_${t}_updated_at ON ${t};
        CREATE TRIGGER trg_${t}_updated_at
          BEFORE UPDATE ON ${t}
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      `);
    }

    /* ── Seed modules so they appear in nav ─────────────────────── */
    // Use individual inserts to safely handle conflicts on either name or slug
    const moduleSeeds = [
      { name: 'Company Master', slug: 'company',      icon: 'Building2', sort: 20, cat: 'management' },
      { name: 'Site Master',    slug: 'sites',        icon: 'MapPin',    sort: 21, cat: 'management' },
      { name: 'Web Services',   slug: 'web-services', icon: 'Globe2',    sort: 22, cat: 'system' },
    ];
    for (const m of moduleSeeds) {
      await client.query(`
        INSERT INTO modules (name, slug, icon, sort_order, category, is_active)
        VALUES ($1,$2,$3,$4,$5,true)
        ON CONFLICT (name) DO UPDATE SET slug=EXCLUDED.slug, icon=EXCLUDED.icon, category=EXCLUDED.category
      `, [m.name, m.slug, m.icon, m.sort, m.cat]);
    }

    /* ── Grant super-admin all perms on new modules ─────────────── */
    await client.query(`
      INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
      SELECT r.id, m.id, pt.perm::permission_type, true
      FROM roles r
      CROSS JOIN modules m
      CROSS JOIN (VALUES ('create'),('read'),('update'),('delete'),('export'),('import'),('approve'),('manage')) pt(perm)
      WHERE r.slug = 'super-admin'
        AND m.slug IN ('company','sites','web-services')
      ON CONFLICT (role_id, module_id, permission_type) DO NOTHING
    `);

    /* ── Admin gets crud+export ──────────────────────────────────── */
    await client.query(`
      INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
      SELECT r.id, m.id, pt.perm::permission_type, true
      FROM roles r
      CROSS JOIN modules m
      CROSS JOIN (VALUES ('create'),('read'),('update'),('delete'),('export')) pt(perm)
      WHERE r.slug = 'admin'
        AND m.slug IN ('company','sites','web-services')
      ON CONFLICT (role_id, module_id, permission_type) DO NOTHING
    `);

    /* ── Seed sample company ─────────────────────────────────────── */
    await client.query(`
      INSERT INTO companies (code, name, legal_name, type, industry, email, phone,
        city, state, country, pincode, gstin, currency, is_default, is_active)
      VALUES ('CORP001', 'Admin Corp Pvt Ltd', 'Admin Corp Private Limited',
        'private_limited', 'Information Technology',
        'info@admincorp.com', '+91-9800000000',
        'Mumbai', 'Maharashtra', 'India', '400001',
        '27AABCU9603R1ZX', 'INR', true, true)
      ON CONFLICT (code) DO NOTHING
    `);

    /* ── Seed a HQ site ──────────────────────────────────────────── */
    await client.query(`
      INSERT INTO sites (company_id, code, name, type, email, phone,
        city, state, country, pincode, is_hq, is_active)
      SELECT id, 'HQ001', 'Head Office', 'hq',
        'hq@admincorp.com', '+91-9800000001',
        'Mumbai', 'Maharashtra', 'India', '400001', true, true
      FROM companies WHERE code = 'CORP001'
      ON CONFLICT (company_id, code) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅ V4 migrations completed! (Company Master, Site Master, Web Services)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ V4 migration failed:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v4();
