const { query } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, getPagination, buildPaginationMeta } = require('../utils/helpers');

/**
 * @swagger
 * tags:
 *   name: Dashboard
 *   description: System-wide stats and overview
 */

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Get dashboard overview stats
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard stats retrieved successfully
 */
const getDashboardStats = async (req, res) => {
  try {
    const [users, depts, projects, tasks, recentLogins, attendance] = await Promise.all([
      query(`SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status='active') as active,
             COUNT(*) FILTER (WHERE status='pending') as pending,
             COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days') as new_week
             FROM users`),
      query(`SELECT COUNT(*) as total FROM departments WHERE is_active=true`),
      query(`SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status='active') as active,
             COUNT(*) FILTER (WHERE status='completed') as completed
             FROM projects`),
      query(`SELECT COUNT(*) as total,
             COUNT(*) FILTER (WHERE status='todo') as todo,
             COUNT(*) FILTER (WHERE status='in_progress') as in_progress,
             COUNT(*) FILTER (WHERE status='done') as done,
             COUNT(*) FILTER (WHERE due_date < NOW() AND status != 'done') as overdue
             FROM tasks`),
      query(`SELECT u.first_name, u.last_name, u.email, u.avatar_url, u.last_login, u.status,
             d.name as department FROM users u
             LEFT JOIN departments d ON d.id=u.department_id
             WHERE u.last_login IS NOT NULL ORDER BY u.last_login DESC LIMIT 5`),
      query(`SELECT COUNT(*) FILTER (WHERE status='present') as present,
             COUNT(*) FILTER (WHERE status='absent') as absent,
             COUNT(*) FILTER (WHERE status='late') as late
             FROM attendance WHERE date = CURRENT_DATE`),
    ]);

    const monthlyGrowth = await query(`
      SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as count
      FROM users WHERE created_at > NOW() - INTERVAL '6 months'
      GROUP BY month ORDER BY month
    `);

    return sendSuccess(res, {
      users: users.rows[0],
      departments: depts.rows[0],
      projects: projects.rows[0],
      tasks: tasks.rows[0],
      attendance: attendance.rows[0],
      recentLogins: recentLogins.rows,
      monthlyGrowth: monthlyGrowth.rows,
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    return sendError(res, 'Failed to fetch dashboard stats', 500);
  }
};

/**
 * @swagger
 * tags:
 *   name: Audit Logs
 *   description: System activity tracking
 */

/**
 * @swagger
 * /api/audit-logs:
 *   get:
 *     summary: Get system audit logs
 *     tags: [Audit Logs]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: userId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Audit logs retrieved successfully
 */
const getAuditLogs = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { userId, action, entityType, from, to } = req.query;

    let conditions = ['1=1'];
    let params = [];
    let idx = 1;

    if (userId) { conditions.push(`al.user_id = $${idx++}`); params.push(userId); }
    if (action) { conditions.push(`al.action = $${idx++}`); params.push(action); }
    if (entityType) { conditions.push(`al.entity_type = $${idx++}`); params.push(entityType); }
    if (from) { conditions.push(`al.created_at >= $${idx++}`); params.push(from); }
    if (to) { conditions.push(`al.created_at <= $${idx++}`); params.push(to); }

    const countRes = await query(
      `SELECT COUNT(*) FROM audit_logs al WHERE ${conditions.join(' AND ')}`,
      params
    );

    const logsRes = await query(
      `SELECT al.*, u.first_name, u.last_name, u.email, u.avatar_url
       FROM audit_logs al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY al.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return sendPaginated(
      res,
      logsRes.rows,
      buildPaginationMeta(countRes.rows[0].count, page, limit)
    );
  } catch (error) {
    console.error('Audit logs error:', error);
    return sendError(res, 'Failed to fetch audit logs', 500);
  }
};

/**
 * @swagger
 * tags:
 *   name: Departments
 *   description: Organization department management
 */

/**
 * @swagger
 * /api/departments:
 *   get:
 *     summary: Get all departments
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of departments retrieved successfully
 */
const getDepartments = async (req, res) => {
  try {
    const deptsRes = await query(
      `SELECT d.*,
              u.first_name as manager_first, u.last_name as manager_last,
              c.name as company_name, c.code as company_code,
              s.name as site_name, s.code as site_code,
              COUNT(DISTINCT u2.id) as employee_count
       FROM departments d
       LEFT JOIN users u  ON u.id = d.manager_id
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN sites s ON s.id = d.site_id
       LEFT JOIN users u2 ON u2.department_id = d.id AND u2.status = 'active'
       GROUP BY d.id, u.first_name, u.last_name, c.name, c.code, s.name, s.code
       ORDER BY d.name`
    );
    return sendSuccess(res, deptsRes.rows);
  } catch (error) {
    return sendError(res, 'Failed to fetch departments', 500);
  }
};

/**
 * @swagger
 * /api/departments:
 *   post:
 *     summary: Create new department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Department created
 */
const createDepartment = async (req, res) => {
  const { name, code, description, managerId, parentId, companyId, siteId } = req.body;
  try {
    const res2 = await query(
      `INSERT INTO departments (name, code, description, manager_id, parent_id, company_id, site_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, code, description, managerId, parentId, req.body.companyId || null, req.body.siteId || null]
    );
    return sendSuccess(res, res2.rows[0], 'Department created', 201);
  } catch (error) {
    if (error.code === '23505') return sendError(res, 'Department code already exists', 409);
    return sendError(res, 'Failed to create department', 500);
  }
};

/**
 * @swagger
 * /api/departments/{id}:
 *   put:
 *     summary: Update department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Department updated
 */
const updateDepartment = async (req, res) => {
  const { id } = req.params;
  const { name, code, description, managerId, isActive, companyId, siteId } = req.body;
  try {
    const res2 = await query(
      `UPDATE departments SET name=$1, code=$2, description=$3, manager_id=$4, is_active=$5, company_id=$6, site_id=$7 WHERE id=$8 RETURNING *`,
      [name, code, description, managerId, isActive, req.body.companyId || null, req.body.siteId || null, id]
    );
    if (!res2.rows.length) return sendError(res, 'Department not found', 404);
    return sendSuccess(res, res2.rows[0], 'Department updated');
  } catch (error) {
    return sendError(res, 'Failed to update department', 500);
  }
};

/**
 * @swagger
 * tags:
 *   name: Notifications
 *   description: User notification management
 */

/**
 * @swagger
 * /api/notifications:
 *   get:
 *     summary: Get user notifications
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Notifications retrieved successfully
 */
const getNotifications = async (req, res) => {
  try {
    const notifsRes = await query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    const unreadCount = await query(
      `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );
    return sendSuccess(res, { notifications: notifsRes.rows, unreadCount: parseInt(unreadCount.rows[0].count) });
  } catch (error) {
    return sendError(res, 'Failed to fetch notifications', 500);
  }
};

/**
 * @swagger
 * /api/notifications/read-all:
 *   put:
 *     summary: Mark all notifications as read
 *     tags: [Notifications]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Success
 */
const markAllNotificationsRead = async (req, res) => {
  try {
    await query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
    return sendSuccess(res, {}, 'All notifications marked as read');
  } catch (error) {
    return sendError(res, 'Failed to update notifications', 500);
  }
};

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: System configuration and settings
 */

/**
 * @swagger
 * /api/settings:
 *   get:
 *     summary: Get system settings
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Settings retrieved successfully
 */
const getSettings = async (req, res) => {
  try {
    const settingsRes = await query(
      req.user.roles?.includes('super-admin')
        ? 'SELECT * FROM settings ORDER BY group_name, key'
        : 'SELECT * FROM settings WHERE is_public = true ORDER BY group_name, key'
    );
    const grouped = {};
    for (const s of settingsRes.rows) {
      if (!grouped[s.group_name]) grouped[s.group_name] = {};
      grouped[s.group_name][s.key] = { value: s.value, type: s.type, description: s.description };
    }
    return sendSuccess(res, grouped);
  } catch (error) {
    return sendError(res, 'Failed to fetch settings', 500);
  }
};

/**
 * @swagger
 * /api/settings:
 *   put:
 *     summary: Update system settings
 *     tags: [Settings]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Settings updated
 */
const updateSettings = async (req, res) => {
  const { settings } = req.body; // { key: value, ... }
  try {
    for (const [key, value] of Object.entries(settings)) {
      await query(
        'UPDATE settings SET value=$1, updated_by=$2 WHERE key=$3',
        [String(value), req.user.id, key]
      );
    }
    return sendSuccess(res, {}, 'Settings updated');
  } catch (error) {
    return sendError(res, 'Failed to update settings', 500);
  }
};


/**
 * @swagger
 * /api/departments/{id}:
 *   delete:
 *     summary: Delete department
 *     tags: [Departments]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Department deleted
 */
const deleteDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const r = await query('SELECT id, name FROM departments WHERE id=$1', [id]);
    if (!r.rows.length) return sendError(res, 'Department not found', 404);
    // Unassign employees
    await query('UPDATE users SET department_id=NULL WHERE department_id=$1', [id]);
    await query('DELETE FROM departments WHERE id=$1', [id]);
    return sendSuccess(res, {}, 'Department deleted');
  } catch (err) {
    return sendError(res, 'Failed to delete department', 500);
  }
};

module.exports = {
  getDashboardStats, getAuditLogs,
  getDepartments, createDepartment, updateDepartment, deleteDepartment,
  getNotifications, markAllNotificationsRead,
  getSettings, updateSettings,
};
