/**
 * migrate_all.js — Safe idempotent migration runner.
 * Runs ALL migrations in sequence. Safe to re-run at any time.
 * Use this instead of running migrate.js, migrate_v2.js, migrate_v3.js separately.
 *
 * Usage:  node src/config/migrate_all.js
 */
require('dotenv').config();
const { pool } = require('./database');

const runAll = async () => {
  const client = await pool.connect();
  try {
    console.log('\n🚀 Running ALL migrations (v1 + v2 + v3)...\n');
    await client.query('BEGIN');

    /* ── EXTENSIONS ─────────────────────────────────────────────── */
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    /* ── ENUMS ───────────────────────────────────────────────────── */
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

    /* ── V1 CORE TABLES ─────────────────────────────────────────── */
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

    // Add manager_id to departments after users exists
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
        assigned_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE(user_id, role_id)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        module_id UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        permission_type permission_type NOT NULL,
        is_granted BOOLEAN DEFAULT true,
        granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE(user_id, module_id, permission_type)
      )`);

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
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS token_blacklist (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        token_hash VARCHAR(255) NOT NULL UNIQUE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        message TEXT,
        type VARCHAR(50) DEFAULT 'info',
        is_read BOOLEAN DEFAULT false,
        link VARCHAR(500),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        key VARCHAR(255) NOT NULL UNIQUE,
        value TEXT,
        type VARCHAR(50) DEFAULT 'string',
        group_name VARCHAR(100),
        description TEXT,
        is_public BOOLEAN DEFAULT false,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_profiles (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        emergency_contact_name VARCHAR(200),
        emergency_contact_phone VARCHAR(20),
        blood_group VARCHAR(10),
        marital_status VARCHAR(20),
        nationality VARCHAR(100),
        pan_number VARCHAR(20),
        aadhar_number VARCHAR(20),
        bank_account VARCHAR(50),
        bank_name VARCHAR(100),
        bank_ifsc VARCHAR(20),
        salary_ctc DECIMAL(12,2),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        check_in TIMESTAMPTZ,
        check_out TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'present',
        working_hours DECIMAL(4,2),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, date)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS leave_requests (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        leave_type VARCHAR(50) NOT NULL,
        from_date DATE NOT NULL,
        to_date DATE NOT NULL,
        days_count DECIMAL(4,1),
        reason TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        approved_at TIMESTAMPTZ,
        rejection_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE,
        description TEXT,
        client_name VARCHAR(200),
        status VARCHAR(50) DEFAULT 'planning',
        priority VARCHAR(20) DEFAULT 'medium',
        start_date DATE,
        end_date DATE,
        budget DECIMAL(15,2),
        spent DECIMAL(15,2) DEFAULT 0,
        manager_id UUID REFERENCES users(id) ON DELETE SET NULL,
        department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
        progress INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_members (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'member',
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(project_id, user_id)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
        title VARCHAR(500) NOT NULL,
        description TEXT,
        assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
        assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(50) DEFAULT 'todo',
        priority VARCHAR(20) DEFAULT 'medium',
        due_date DATE,
        estimated_hours DECIMAL(6,2),
        actual_hours DECIMAL(6,2),
        tags TEXT[],
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    /* ── V2: VERTICALS + IP TRACKING ────────────────────────────── */
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
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vertical_members (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        vertical_id UUID NOT NULL REFERENCES verticals(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(60) DEFAULT 'member',
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(vertical_id, user_id)
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
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS blocked_ips (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        ip_address INET NOT NULL UNIQUE,
        reason TEXT,
        blocked_by UUID REFERENCES users(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ,
        is_permanent BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    /* ── V3: LOGIN SESSIONS ──────────────────────────────────────── */
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
      )`);

    /* ── SAFE COLUMN ADDITIONS (won't fail if column already exists) */
    const addCol = async (table, col, type) => {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    };
    await addCol('users', 'last_login_ip',      'INET');
    await addCol('users', 'previous_login',     'TIMESTAMPTZ');
    await addCol('users', 'previous_login_ip',  'INET');
    await addCol('modules','version',   'VARCHAR(20) DEFAULT \'1.0.0\'');
    await addCol('modules','category',  'VARCHAR(60) DEFAULT \'core\'');
    await addCol('modules','config',    'JSONB DEFAULT \'{}\'');
    await addCol('modules','updated_at','TIMESTAMPTZ DEFAULT NOW()');

    /* ── INDEXES ─────────────────────────────────────────────────── */
    const idx = async (name, table, cols) => {
      await client.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${cols})`);
    };
    await idx('idx_users_email',        'users',         'email');
    await idx('idx_users_status',       'users',         'status');
    await idx('idx_users_dept',         'users',         'department_id');
    await idx('idx_user_roles_user',    'user_roles',    'user_id');
    await idx('idx_user_roles_role',    'user_roles',    'role_id');
    await idx('idx_permissions_role',   'permissions',   'role_id');
    await idx('idx_audit_user',         'audit_logs',    'user_id');
    await idx('idx_audit_created',      'audit_logs',    'created_at DESC');
    await idx('idx_notifications_user', 'notifications', 'user_id, is_read');
    await idx('idx_ip_tracking_ip',     'ip_tracking',   'ip_address');
    await idx('idx_ip_tracking_user',   'ip_tracking',   'user_id');
    await idx('idx_ip_tracking_created','ip_tracking',   'created_at DESC');
    await idx('idx_ip_tracking_event',  'ip_tracking',   'event_type');
    await idx('idx_blocked_ips_ip',     'blocked_ips',   'ip_address');
    await idx('idx_sessions_user',      'login_sessions','user_id');
    await idx('idx_sessions_ip',        'login_sessions','ip_address');
    await idx('idx_sessions_login',     'login_sessions','login_at DESC');

    /* ── updated_at trigger ─────────────────────────────────────── */
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ language 'plpgsql';
    `);
    const triggerTables = [
      'users','roles','permissions','modules','departments','user_permissions',
      'employee_profiles','leave_requests','projects','tasks','settings','verticals'
    ];
    for (const t of triggerTables) {
      await client.query(`
        DROP TRIGGER IF EXISTS trg_${t}_updated_at ON ${t};
        CREATE TRIGGER trg_${t}_updated_at
          BEFORE UPDATE ON ${t}
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      `);
    }

    await client.query('COMMIT');
    console.log('✅ All migrations completed successfully!\n');
    console.log('👉 Next step: run   npm run seed\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', err.message);
    console.error('Detail:', err.detail || '');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

runAll();
