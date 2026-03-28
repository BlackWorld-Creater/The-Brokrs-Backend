const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'erp_admin_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres123',
});

async function testConnection() {
  try {
    console.log('Testing connection with:');
    console.log('User:', process.env.DB_USER || 'postgres');
    console.log('Database:', process.env.DB_NAME || 'erp_admin_db');
    console.log('Password length:', (process.env.DB_PASSWORD || 'postgres123').length);
    
    const client = await pool.connect();
    console.log('✅ Connection successful!');
    const res = await client.query('SELECT current_database(), current_user');
    console.log('Info:', res.rows[0]);
    client.release();
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
  } finally {
    await pool.end();
  }
}

testConnection();
