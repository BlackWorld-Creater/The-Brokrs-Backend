const { query, pool } = require('./src/config/database');

async function checkUsers() {
  try {
    const res = await query('SELECT id, email, first_name FROM users');
    console.log('✅ Users count:', res.rowCount);
    if (res.rowCount > 0) {
      console.log('Sample user:', res.rows[0]);
    } else {
      console.log('⚠️ No users found in database!');
      console.log('Running npm run seed might be necessary.');
    }
  } catch (err) {
    console.error('❌ Query failed:', err.message);
  } finally {
    await pool.end();
  }
}

checkUsers();
