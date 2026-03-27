const bcrypt = require('bcryptjs');
const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');

/* ── strip sensitive fields before storing in audit log ─────────── */
const sanitizeForAudit = (obj) => {
  if (!obj) return null;
  const safe = { ...obj };
  const SENSITIVE = ['password_hash','refresh_token_hash','two_factor_secret',
                     'password_reset_token','email_verify_token'];
  SENSITIVE.forEach(k => { if (safe[k] !== undefined) safe[k] = '[REDACTED]'; });
  return safe;
};

/**
 * @swagger
 * tags:
 *   name: Users
 *   description: User management and profile retrieval
 */

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of users retrieved successfully
 */
const getUsers = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { search, status, departmentId } = req.query;
    const conds = ['1=1'], params = [];
    let idx = 1;
    if (search)       { conds.push(`(u.first_name ILIKE $${idx} OR u.last_name ILIKE $${idx} OR u.email ILIKE $${idx} OR u.employee_id ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (status)       { conds.push(`u.status=$${idx++}`);        params.push(status); }
    if (departmentId) { conds.push(`u.department_id=$${idx++}`); params.push(departmentId); }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM users u WHERE ${where}`, params);
    const rows = await query(
      `SELECT u.id, u.employee_id, u.first_name, u.last_name, u.email, u.phone,
              u.status, u.designation, u.avatar_url, u.last_login, u.last_login_ip,
              u.created_at, d.name as department_name,
              array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL) as roles
       FROM users u
       LEFT JOIN departments d ON d.id=u.department_id
       LEFT JOIN user_roles ur ON ur.user_id=u.id
       LEFT JOIN roles r ON r.id=ur.role_id
       WHERE ${where}
       GROUP BY u.id, d.name
       ORDER BY u.created_at DESC
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { console.error(err); return sendError(res, 'Failed to fetch users', 500); }
};

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User found
 *       404:
 *         description: User not found
 */
const getUserById = async (req, res) => {
  try {
    const userRes = await query(
      `SELECT u.id, u.employee_id, u.first_name, u.last_name, u.email, u.phone,
              u.status, u.designation, u.avatar_url, u.date_of_joining, u.date_of_birth,
              u.address, u.city, u.country, u.timezone,
              u.last_login, u.last_login_ip, u.previous_login, u.previous_login_ip,
              u.must_change_password, u.two_factor_enabled, u.email_verified,
              u.created_at, u.updated_at, d.name as department_name, d.id as department_id,
              array_agg(DISTINCT jsonb_build_object('id',r.id,'name',r.name,'slug',r.slug))
                FILTER (WHERE r.id IS NOT NULL) as roles
       FROM users u
       LEFT JOIN departments d ON d.id=u.department_id
       LEFT JOIN user_roles ur ON ur.user_id=u.id
       LEFT JOIN roles r ON r.id=ur.role_id AND r.is_active=true
       WHERE u.id=$1
       GROUP BY u.id, d.name, d.id`,
      [req.params.id]
    );
    if (!userRes.rows.length) return sendError(res, 'User not found', 404);

    // Recent login sessions
    const sessions = await query(
      `SELECT ip_address::text, login_at, logout_at, user_agent,
              is_active, is_suspicious, country, city, browser, device_type
       FROM login_sessions WHERE user_id=$1 ORDER BY login_at DESC LIMIT 10`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));

    return sendSuccess(res, { ...userRes.rows[0], loginSessions: sessions.rows });
  } catch (err) { console.error(err); return sendError(res, 'Failed to fetch user', 500); }
};

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Create new user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - firstName
 *               - lastName
 *               - email
 *               - password
 *             properties:
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created successfully
 */
const createUser = async (req, res) => {
  const { firstName, lastName, email, password, phone, departmentId,
          designation, dateOfJoining, roleIds, status = 'active' } = req.body;
  try {
    const exists = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (exists.rows.length) return sendError(res, 'Email already exists', 409);

    const result = await transaction(async (client) => {
      const passwordHash = await bcrypt.hash(password || 'TempPass@123!', 12);
      const countRes = await client.query('SELECT COUNT(*) FROM users');
      const empId = `EMP${String(parseInt(countRes.rows[0].count) + 1).padStart(4, '0')}`;
      const r = await client.query(
        `INSERT INTO users (employee_id,first_name,last_name,email,password_hash,phone,
         department_id,designation,date_of_joining,status,created_by,must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) RETURNING *`,
        [empId, firstName, lastName, email, passwordHash, phone,
         departmentId, designation, dateOfJoining, status, req.user.id]
      );
      const newUser = r.rows[0];
      if (roleIds?.length) {
        for (const roleId of roleIds) {
          await client.query(
            'INSERT INTO user_roles (user_id,role_id,assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
            [newUser.id, roleId, req.user.id]
          );
        }
      }
      return newUser;
    });

    await auditLog({
      userId: req.user.id, action: 'CREATE', entityType: 'user', entityId: result.id,
      newValues: sanitizeForAudit({
        email: result.email, firstName, lastName, designation, status,
        departmentId, roleIds,
      }),
      req,
    });
    return sendSuccess(res, { id: result.id, email: result.email, employeeId: result.employee_id },
                       'User created successfully', 201);
  } catch (err) { console.error(err); return sendError(res, 'Failed to create user', 500); }
};

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User updated successfully
 */
const updateUser = async (req, res) => {
  const { id } = req.params;
  const { firstName, lastName, phone, departmentId, designation,
          dateOfJoining, status, roleIds } = req.body;
  try {
    const oldRes = await query('SELECT * FROM users WHERE id=$1', [id]);
    if (!oldRes.rows.length) return sendError(res, 'User not found', 404);
    const old = oldRes.rows[0];

    await transaction(async (client) => {
      await client.query(
        `UPDATE users SET first_name=$1,last_name=$2,phone=$3,department_id=$4,
         designation=$5,date_of_joining=$6,status=$7,company_id=$8,site_id=$9 WHERE id=$10`,
        [firstName, lastName, phone, departmentId, designation, dateOfJoining, status,
         req.body.companyId||null, req.body.siteId||null, id]
      );
      if (roleIds !== undefined) {
        await client.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
        for (const roleId of roleIds) {
          await client.query(
            'INSERT INTO user_roles (user_id,role_id,assigned_by) VALUES ($1,$2,$3)',
            [id, roleId, req.user.id]
          );
        }
      }
    });

    /* Store human-readable diff in audit log */
    const oldValues = sanitizeForAudit({
      firstName: old.first_name, lastName: old.last_name,
      phone: old.phone, designation: old.designation,
      status: old.status, departmentId: old.department_id,
    });
    const newValues = sanitizeForAudit({
      firstName, lastName, phone, designation, status, departmentId
    });

    await auditLog({
      userId: req.user.id, action: 'UPDATE', entityType: 'user', entityId: id,
      oldValues, newValues, req,
    });
    return sendSuccess(res, {}, 'User updated successfully');
  } catch (err) { console.error(err); return sendError(res, 'Failed to update user', 500); }
};

/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Deactivate user
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deactivated
 */
const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    if (id === req.user.id) return sendError(res, 'Cannot delete your own account', 400);
    const userRes = await query('SELECT * FROM users WHERE id=$1', [id]);
    if (!userRes.rows.length) return sendError(res, 'User not found', 404);
    const old = userRes.rows[0];
    await query('UPDATE users SET status=$1 WHERE id=$2', ['inactive', id]);
    await auditLog({
      userId: req.user.id, action: 'DELETE', entityType: 'user', entityId: id,
      oldValues: sanitizeForAudit({ email: old.email, status: old.status, firstName: old.first_name }),
      newValues: { status: 'inactive' },
      req,
    });
    return sendSuccess(res, {}, 'User deactivated successfully');
  } catch (err) { return sendError(res, 'Failed to delete user', 500); }
};

/**
 * @swagger
 * /api/users/{id}/permissions:
 *   put:
 *     summary: Update user-specific permissions
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Permissions updated
 */
const updateUserPermissions = async (req, res) => {
  const { id } = req.params;
  const { permissions } = req.body;
  try {
    await transaction(async (client) => {
      await client.query('DELETE FROM user_permissions WHERE user_id=$1', [id]);
      for (const p of permissions) {
        await client.query(
          `INSERT INTO user_permissions (user_id,module_id,permission_type,is_granted,granted_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, p.moduleId, p.permissionType, p.isGranted, req.user.id]
        );
      }
    });
    await auditLog({
      userId: req.user.id, action: 'UPDATE', entityType: 'user_permissions', entityId: id,
      newValues: { permissionsUpdated: permissions.length, userId: id }, req,
    });
    return sendSuccess(res, {}, 'User permissions updated');
  } catch (err) { return sendError(res, 'Failed to update permissions', 500); }
};

/**
 * @swagger
 * /api/users/{id}/reset-password:
 *   post:
 *     summary: Reset user password (admin)
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Password reset successfully
 */
const resetUserPassword = async (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  try {
    const hash = await bcrypt.hash(newPassword || 'TempPass@123!', 12);
    await query('UPDATE users SET password_hash=$1,must_change_password=true WHERE id=$2', [hash, id]);
    await auditLog({
      userId: req.user.id, action: 'UPDATE', entityType: 'user', entityId: id,
      newValues: { action: 'admin_password_reset', targetUserId: id },
      req,
    });
    return sendSuccess(res, {}, 'Password reset successfully');
  } catch (err) { return sendError(res, 'Failed to reset password', 500); }
};

/**
 * @swagger
 * /api/users/stats:
 *   get:
 *     summary: Get user statistics
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User stats retrieved
 */
const getUserStats = async (req, res) => {
  try {
    const stats = await query(`
      SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status='active')    as active,
             COUNT(*) FILTER (WHERE status='inactive')  as inactive,
             COUNT(*) FILTER (WHERE status='suspended') as suspended,
             COUNT(*) FILTER (WHERE status='pending')   as pending,
             COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '30 days') as new_this_month
      FROM users
    `);
    return sendSuccess(res, stats.rows[0]);
  } catch (err) { return sendError(res, 'Failed to fetch stats', 500); }
};

/**
 * @swagger
 * /api/users/{id}/login-history:
 *   get:
 *     summary: Get user login history
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Login history retrieved
 */
const getUserLoginHistory = async (req, res) => {
  try {
    const rows = await query(
      `SELECT ls.*, ls.ip_address::text as ip_text
       FROM login_sessions ls
       WHERE ls.user_id=$1 ORDER BY ls.login_at DESC LIMIT 20`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    return sendSuccess(res, rows.rows);
  } catch (err) { return sendError(res, 'Failed to fetch login history', 500); }
};

module.exports = {
  getUsers, getUserById, createUser, updateUser, deleteUser,
  updateUserPermissions, resetUserPassword, getUserStats, getUserLoginHistory,
};
