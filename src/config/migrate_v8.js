require('dotenv').config();
const { pool } = require('./database');

const migrate_v8 = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create separate 'my-dashboard' module
    await client.query(`
      INSERT INTO modules (name, slug, icon, sort_order, category, is_active)
      VALUES ('My Dashboard', 'my-dashboard', 'LayoutGrid', 2, 'core', true)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, icon=EXCLUDED.icon
    `);

    // Super Admin + Admin — full access to both dashboards
    await client.query(`
      INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
      SELECT r.id, m.id, pt.perm::permission_type, true
      FROM roles r
      CROSS JOIN modules m
      CROSS JOIN (VALUES ('create'),('read'),('update'),('delete'),('manage')) pt(perm)
      WHERE m.slug = 'my-dashboard'
        AND r.slug IN ('super-admin','admin')
      ON CONFLICT (role_id, module_id, permission_type) DO NOTHING
    `);

    // All other roles (HR Manager, Project Manager, Employee, Viewer)
    // get READ access to My Dashboard only — NOT main dashboard
    await client.query(`
      INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
      SELECT r.id, m.id, 'read'::permission_type, true
      FROM roles r
      CROSS JOIN modules m
      WHERE m.slug = 'my-dashboard'
        AND r.slug IN ('hr-manager','project-manager','employee','viewer')
      ON CONFLICT (role_id, module_id, permission_type) DO NOTHING
    `);

    // Revoke main 'dashboard' access from Employee and Viewer roles
    // (they can only see My Dashboard, not the admin stats overview)
    await client.query(`
      UPDATE permissions SET is_granted = false
      WHERE module_id = (SELECT id FROM modules WHERE slug='dashboard')
        AND role_id IN (
          SELECT id FROM roles WHERE slug IN ('employee','viewer')
        )
    `);

    await client.query('COMMIT');
    console.log('✅ V8 done — my-dashboard module created with separate permissions');
    console.log('   Main Dashboard: Super Admin, Admin, HR Manager, Project Manager');
    console.log('   My Dashboard:   All roles (everyone can see their own data)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ V8 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
};

migrate_v8();
