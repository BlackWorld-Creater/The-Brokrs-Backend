const { pool } = require('./database');
const bcrypt = require('bcryptjs');

const seed = async () => {
  const client = await pool.connect();
  try {
    console.log('🌱 Seeding database...');
    await client.query('BEGIN');

    // Seed Modules (ERP Modules)
    const modules = [
      { name: 'Dashboard', slug: 'dashboard', icon: 'LayoutDashboard', sort_order: 1 },
      { name: 'User Management', slug: 'users', icon: 'Users', sort_order: 2 },
      { name: 'Role & Permissions', slug: 'roles', icon: 'Shield', sort_order: 3 },
      { name: 'Human Resources', slug: 'hr', icon: 'UserCog', sort_order: 4 },
      { name: 'Attendance', slug: 'attendance', icon: 'Clock', sort_order: 5 },
      { name: 'Leave Management', slug: 'leave', icon: 'Calendar', sort_order: 6 },
      { name: 'Payroll', slug: 'payroll', icon: 'CreditCard', sort_order: 7 },
      { name: 'Projects', slug: 'projects', icon: 'Briefcase', sort_order: 8 },
      { name: 'Tasks', slug: 'tasks', icon: 'CheckSquare', sort_order: 9 },
      { name: 'Departments', slug: 'departments', icon: 'Building', sort_order: 10 },
      { name: 'Reports & Analytics', slug: 'reports', icon: 'BarChart2', sort_order: 11 },
      { name: 'Audit Logs', slug: 'audit', icon: 'FileText', sort_order: 12 },
      { name: 'Notifications', slug: 'notifications', icon: 'Bell', sort_order: 13 },
      { name: 'Settings', slug: 'settings', icon: 'Settings', sort_order: 14 },
    ];

    const moduleIds = {};
    for (const mod of modules) {
      const res = await client.query(
        `INSERT INTO modules (name, slug, icon, sort_order) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET name=$1, icon=$3 RETURNING id`,
        [mod.name, mod.slug, mod.icon, mod.sort_order]
      );
      moduleIds[mod.slug] = res.rows[0].id;
    }
    console.log('✅ Modules seeded');

    // Seed Roles
    const roles = [
      { name: 'Super Admin', slug: 'super-admin', description: 'Full system access', is_system: true },
      { name: 'Admin', slug: 'admin', description: 'Administrative access', is_system: true },
      { name: 'HR Manager', slug: 'hr-manager', description: 'HR module full access', is_system: false },
      { name: 'Project Manager', slug: 'project-manager', description: 'Project & task management', is_system: false },
      { name: 'Employee', slug: 'employee', description: 'Basic employee access', is_system: false },
      { name: 'Viewer', slug: 'viewer', description: 'Read-only access', is_system: false },
    ];

    const roleIds = {};
    for (const role of roles) {
      const res = await client.query(
        `INSERT INTO roles (name, slug, description, is_system) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET name=$1, description=$3 RETURNING id`,
        [role.name, role.slug, role.description, role.is_system]
      );
      roleIds[role.slug] = res.rows[0].id;
    }
    console.log('✅ Roles seeded');

    // Seed Permissions for Super Admin (all permissions)
    const permTypes = ['create', 'read', 'update', 'delete', 'export', 'import', 'approve', 'manage'];
    for (const slug of Object.keys(moduleIds)) {
      for (const perm of permTypes) {
        await client.query(
          `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
           VALUES ($1, $2, $3, true) ON CONFLICT (role_id, module_id, permission_type) DO NOTHING`,
          [roleIds['super-admin'], moduleIds[slug], perm]
        );
      }
    }

    // Admin permissions (all except manage)
    const adminPerms = ['create', 'read', 'update', 'delete', 'export', 'approve'];
    for (const slug of Object.keys(moduleIds)) {
      for (const perm of adminPerms) {
        await client.query(
          `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
           VALUES ($1, $2, $3, true) ON CONFLICT (role_id, module_id, permission_type) DO NOTHING`,
          [roleIds['admin'], moduleIds[slug], perm]
        );
      }
    }

    // HR Manager
    const hrModules = ['dashboard', 'hr', 'attendance', 'leave', 'payroll', 'departments', 'reports'];
    for (const slug of hrModules) {
      for (const perm of ['create', 'read', 'update', 'delete', 'export', 'approve']) {
        await client.query(
          `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
           VALUES ($1, $2, $3, true) ON CONFLICT (role_id, module_id, permission_type) DO NOTHING`,
          [roleIds['hr-manager'], moduleIds[slug], perm]
        );
      }
    }

    // Project Manager
    const pmModules = ['dashboard', 'projects', 'tasks', 'reports', 'notifications'];
    for (const slug of pmModules) {
      for (const perm of ['create', 'read', 'update', 'delete', 'export']) {
        await client.query(
          `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
           VALUES ($1, $2, $3, true) ON CONFLICT (role_id, module_id, permission_type) DO NOTHING`,
          [roleIds['project-manager'], moduleIds[slug], perm]
        );
      }
    }

    // Employee - limited access
    const empModules = ['dashboard', 'attendance', 'leave', 'tasks', 'notifications'];
    for (const slug of empModules) {
      await client.query(
        `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
         VALUES ($1, $2, 'read', true) ON CONFLICT (role_id, module_id, permission_type) DO NOTHING`,
        [roleIds['employee'], moduleIds[slug]]
      );
    }
    // Employee can create leave requests and check in
    for (const slug of ['leave', 'attendance']) {
      await client.query(
        `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
         VALUES ($1, $2, 'create', true) ON CONFLICT (role_id, module_id, permission_type) DO NOTHING`,
        [roleIds['employee'], moduleIds[slug]]
      );
    }

    // Viewer - read only all
    for (const slug of Object.keys(moduleIds)) {
      await client.query(
        `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
         VALUES ($1, $2, 'read', true) ON CONFLICT (role_id, module_id, permission_type) DO NOTHING`,
        [roleIds['viewer'], moduleIds[slug]]
      );
    }
    console.log('✅ Permissions seeded');

    // Seed Default Department
    const deptRes = await client.query(
      `INSERT INTO departments (name, code, description) VALUES ('Administration', 'ADMIN', 'Main administration department')
       ON CONFLICT (code) DO UPDATE SET name='Administration' RETURNING id`
    );
    const adminDeptId = deptRes.rows[0].id;

    // Seed Super Admin User
    const passwordHash = await bcrypt.hash('Admin@123456', 12);
    const userRes = await client.query(
      `INSERT INTO users (employee_id, first_name, last_name, email, password_hash, status, department_id, designation, email_verified)
       VALUES ('EMP001', 'Super', 'Admin', 'admin@erpadmin.com', $1, 'active', $2, 'System Administrator', true)
       ON CONFLICT (email) DO UPDATE SET first_name='Super', last_name='Admin' RETURNING id`,
      [passwordHash, adminDeptId]
    );
    const superAdminId = userRes.rows[0].id;

    // Assign super-admin role
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING`,
      [superAdminId, roleIds['super-admin']]
    );
    console.log('✅ Super admin user seeded (admin@erpadmin.com / Admin@123456)');

    // Seed a sample employee
    const empPasswordHash = await bcrypt.hash('Employee@123', 12);
    await client.query(`
      INSERT INTO departments (name, code, description) VALUES ('Engineering', 'ENG', 'Software engineering department')
      ON CONFLICT (code) DO NOTHING
    `);
    const engDeptRes = await client.query(`SELECT id FROM departments WHERE code = 'ENG'`);
    const engDeptId = engDeptRes.rows[0].id;

    const empUserRes = await client.query(
      `INSERT INTO users (employee_id, first_name, last_name, email, password_hash, status, department_id, designation, email_verified)
       VALUES ('EMP002', 'John', 'Doe', 'john.doe@erpadmin.com', $1, 'active', $2, 'Software Engineer', true)
       ON CONFLICT (email) DO UPDATE SET first_name='John' RETURNING id`,
      [empPasswordHash, engDeptId]
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [empUserRes.rows[0].id, roleIds['employee']]
    );

    // Default Settings
    const settings = [
      { key: 'company_name', value: 'ERP Admin Corp', type: 'string', group_name: 'general', is_public: true },
      { key: 'company_email', value: 'info@erpadmin.com', type: 'string', group_name: 'general', is_public: true },
      { key: 'company_phone', value: '+91-9999999999', type: 'string', group_name: 'general', is_public: true },
      { key: 'timezone', value: 'Asia/Kolkata', type: 'string', group_name: 'general', is_public: true },
      { key: 'currency', value: 'INR', type: 'string', group_name: 'general', is_public: true },
      { key: 'date_format', value: 'DD/MM/YYYY', type: 'string', group_name: 'general', is_public: true },
      { key: 'max_login_attempts', value: '5', type: 'number', group_name: 'security', is_public: false },
      { key: 'session_timeout', value: '30', type: 'number', group_name: 'security', is_public: false },
      { key: 'password_min_length', value: '8', type: 'number', group_name: 'security', is_public: false },
      { key: 'working_hours_per_day', value: '8', type: 'number', group_name: 'hr', is_public: false },
      { key: 'annual_leave_days', value: '21', type: 'number', group_name: 'hr', is_public: false },
    ];

    for (const s of settings) {
      await client.query(
        `INSERT INTO settings (key, value, type, group_name, is_public) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key) DO UPDATE SET value=$2`,
        [s.key, s.value, s.type, s.group_name, s.is_public]
      );
    }
    console.log('✅ Settings seeded');

    await client.query('COMMIT');
    console.log('\n🎉 Database seeded successfully!');
    console.log('📧 Admin Email: admin@erpadmin.com');
    console.log('🔑 Admin Password: Admin@123456');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

seed().catch(console.error);
