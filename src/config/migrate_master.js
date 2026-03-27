/**
 * master_migrate.js — The Ultimate IDEMPOTENT Migration Runner.
 * Consolidates ALL migrations (v1 through v9) into one single execution.
 * Safe to run on a brand new database OR an existing one.
 */
const config = require('./env');
const { pool } = require('./database');

const runMasterMigration = async () => {
  const client = await pool.connect();
  try {
    console.log(`\n🚀 Starting Master Migration (Consolidated v1-v9)...`);
    console.log(`🌍 Target: ${config.db.database} on ${config.db.host}\n`);
    
    await client.query('BEGIN');

    /* ── 1. EXTENSIONS ─────────────────────────────────────────────── */
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    /* ── 2. ENUMS ───────────────────────────────────────────────────── */
    const createEnum = async (name, values) => {
      await client.query(`
        DO $$ BEGIN
          CREATE TYPE ${name} AS ENUM (${values.map(v => `'${v}'`).join(',')});
        EXCEPTION WHEN duplicate_object THEN null; END $$;
      `);
    };
    await createEnum('user_status',   ['active','inactive','suspended','pending']);
    await createEnum('permission_type',['create','read','update','delete','export','import','approve','manage']);
    await createEnum('audit_action',  ['CREATE','UPDATE','DELETE','LOGIN','LOGOUT','EXPORT','IMPORT','ACCESS_DENIED']);

    /* ── 3. CORE TABLES (v1) ────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS modules (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        icon VARCHAR(50),
        parent_id UUID REFERENCES modules(id) ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        version VARCHAR(20) DEFAULT '1.0.0',
        category VARCHAR(60) DEFAULT 'core',
        config JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        is_system BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(100) NOT NULL,
        code VARCHAR(20) UNIQUE,
        description TEXT,
        parent_id UUID REFERENCES departments(id) ON DELETE SET NULL,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        employee_id VARCHAR(50) UNIQUE,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        phone VARCHAR(20),
        avatar_url VARCHAR(500),
        status user_status DEFAULT 'pending',
        department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
        designation VARCHAR(100),
        date_of_joining DATE,
        date_of_birth DATE,
        address TEXT,
        city VARCHAR(100),
        country VARCHAR(100) DEFAULT 'India',
        timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
        last_login TIMESTAMPTZ,
        last_login_ip INET,
        previous_login TIMESTAMPTZ,
        previous_login_ip INET,
        login_attempts INTEGER DEFAULT 0,
        locked_until TIMESTAMPTZ,
        must_change_password BOOLEAN DEFAULT false,
        two_factor_enabled BOOLEAN DEFAULT false,
        two_factor_secret VARCHAR(255),
        refresh_token_hash VARCHAR(255),
        password_reset_token VARCHAR(255),
        password_reset_expires TIMESTAMPTZ,
        email_verified BOOLEAN DEFAULT false,
        email_verify_token VARCHAR(255),
        created_by UUID,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`ALTER TABLE departments ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        permission_type permission_type NOT NULL,
        is_granted BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(role_id, module_id, permission_type)
      )`);

    /* ── 4. ENTERPRISE TABLES (v4: Companies, Sites, WebServices) ────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        code VARCHAR(30) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        legal_name VARCHAR(255),
        type VARCHAR(60) DEFAULT 'private_limited',
        industry VARCHAR(100),
        logo_url VARCHAR(500),
        website VARCHAR(300),
        email VARCHAR(255),
        phone VARCHAR(30),
        is_active BOOLEAN DEFAULT true,
        is_default BOOLEAN DEFAULT false,
        currency VARCHAR(10) DEFAULT 'INR',
        city VARCHAR(100),
        state VARCHAR(100),
        country VARCHAR(100) DEFAULT 'India',
        pincode VARCHAR(20),
        gstin VARCHAR(20),
        pan_number VARCHAR(20),
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sites (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        code VARCHAR(30) NOT NULL,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(60)  DEFAULT 'branch',
        city VARCHAR(100),
        state VARCHAR(100),
        country VARCHAR(100) DEFAULT 'India',
        is_hq BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_id, code)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS web_services (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(150) NOT NULL,
        slug VARCHAR(150) NOT NULL UNIQUE,
        base_url VARCHAR(500) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    /* ── 5. CROSS-RELATIONAL COLUMNS (v5, v6) ────────────────────────── */
    const addCol = async (table, col, type) => {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    };
    await addCol('users', 'company_id', 'UUID REFERENCES companies(id) ON DELETE SET NULL');
    await addCol('users', 'site_id',    'UUID REFERENCES sites(id) ON DELETE SET NULL');
    await addCol('departments', 'company_id', 'UUID REFERENCES companies(id) ON DELETE SET NULL');
    await addCol('departments', 'site_id',    'UUID REFERENCES sites(id) ON DELETE SET NULL');

    /* ── 6. AUDIT & TRACKING (v2: Logs, IP, Sessions) ────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        action audit_action NOT NULL,
        entity_type VARCHAR(100),
        entity_id UUID,
        old_values JSONB,
        new_values JSONB,
        ip_address INET,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ip_tracking (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        ip_address INET NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        event_type VARCHAR(60) NOT NULL DEFAULT 'request',
        path VARCHAR(500),
        method VARCHAR(10),
        status_code INTEGER,
        country VARCHAR(100),
        city VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS login_sessions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ip_address INET NOT NULL,
        user_agent TEXT,
        login_at TIMESTAMPTZ DEFAULT NOW(),
        logout_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT true,
        country VARCHAR(100),
        city VARCHAR(100)
      )`);

    /* ── 7. WORK & COLLABORATION (v6, v9: Tasks, Projects, Chat) ─────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE,
        description TEXT,
        status VARCHAR(50) DEFAULT 'planning',
        company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(50) DEFAULT 'todo',
        priority VARCHAR(20) DEFAULT 'medium',
        due_date DATE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        type VARCHAR(20) NOT NULL DEFAULT 'direct',
        name VARCHAR(200),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        room_id UUID NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    /* ── 8. HR & ATTENDANCE ─────────────────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        check_in TIMESTAMPTZ,
        check_out TIMESTAMPTZ,
        UNIQUE(user_id, date)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        leave_type VARCHAR(50) NOT NULL,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    /* ── 9. SETTINGS & PREFERENCES (v7) ────────────────────────────── */
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        key VARCHAR(255) NOT NULL UNIQUE,
        value TEXT,
        group_name VARCHAR(100),
        is_public BOOLEAN DEFAULT false,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        theme VARCHAR(20) DEFAULT 'dark',
        dashboard_widgets JSONB DEFAULT '["tasks","attendance","leave","notifications"]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    /* ── 10. INDEXES & PERFORMANCE ──────────────────────────────────── */
    const idx = async (name, table, cols) => {
      await client.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${cols})`);
    };
    await idx('idx_users_email',        'users',         'email');
    await idx('idx_audit_created',      'audit_logs',    'created_at DESC');
    await idx('idx_ip_tracking_created','ip_tracking',   'created_at DESC');
    await idx('idx_sessions_login',     'login_sessions','login_at DESC');
    await idx('idx_chat_msg_room',      'chat_messages', 'room_id, created_at DESC');

    /* ── 11. TRIGGERS (updated_at) ──────────────────────────────────── */
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ language 'plpgsql';
    `);
    const triggerTables = [
      'users','roles','permissions','modules','departments','projects','tasks','settings','web_services','companies','sites','chat_rooms'
    ];
    for (const t of triggerTables) {
      await client.query(`
        DROP TRIGGER IF EXISTS trg_${t}_updated_at ON ${t};
        CREATE TRIGGER trg_${t}_updated_at
          BEFORE UPDATE ON ${t}
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      `);
    }

    /* ── 12. SYNC LOGIC (v5: Default Company Assignment) ────────────── */
    const defaultCompany = await client.query(`SELECT id FROM companies WHERE is_default = true LIMIT 1`);
    if (defaultCompany.rows.length) {
      const companyId = defaultCompany.rows[0].id;
      await client.query(`UPDATE users SET company_id = $1 WHERE company_id IS NULL`, [companyId]);
      await client.query(`UPDATE departments SET company_id = $1 WHERE company_id IS NULL`, [companyId]);
    }

    await client.query('COMMIT');
    console.log('\n✅ Master Migration Completed Successfully! (Consolidated v1-v9)');
    console.log('👉 Next step: npm run seed\n');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Master Migration Failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runMasterMigration();
