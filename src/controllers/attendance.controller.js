const { query } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');

/**
 * @swagger
 * tags:
 *   name: Attendance
 *   description: Employee attendance and check-in/out tracking
 */

/**
 * @swagger
 * /api/attendance:
 *   get:
 *     summary: Get attendance records
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Attendance records retrieved
 */
const getAttendance = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { userId, from, to, status } = req.query;
    const conds = ['1=1'], params = [];
    let idx = 1;
    if (userId) { conds.push(`a.user_id=$${idx++}`); params.push(userId); }
    if (status) { conds.push(`a.status=$${idx++}`); params.push(status); }
    if (from)   { conds.push(`a.date >= $${idx++}`); params.push(from); }
    if (to)     { conds.push(`a.date <= $${idx++}`); params.push(to); }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM attendance a WHERE ${where}`, params);
    const rows = await query(
      `SELECT a.*, u.first_name, u.last_name, u.employee_id, u.avatar_url, d.name as department_name
       FROM attendance a
       JOIN users u ON u.id=a.user_id
       LEFT JOIN departments d ON d.id=u.department_id
       WHERE ${where} ORDER BY a.date DESC, u.first_name
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/attendance:
 *   post:
 *     summary: Admin/Manual mark attendance
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Attendance marked
 */
const markAttendance = async (req, res) => {
  const { userId, date, checkIn, checkOut, status, notes } = req.body;
  try {
    const workingHours = (checkIn && checkOut)
      ? Math.round(((new Date(checkOut) - new Date(checkIn)) / 3600000) * 100) / 100
      : null;
    const r = await query(
      `INSERT INTO attendance (user_id, date, check_in, check_out, status, working_hours, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, date) DO UPDATE SET
         check_in=$3, check_out=$4, status=$5, working_hours=$6, notes=$7
       RETURNING *`,
      [userId, date, checkIn || null, checkOut || null, status || 'present', workingHours, notes]
    );
    return sendSuccess(res, r.rows[0], 'Attendance marked');
  } catch (err) { console.error(err); return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/attendance/stats:
 *   get:
 *     summary: Get attendance analytics
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stats retrieved successfully
 */
const getAttendanceStats = async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7);
    const [summary, byStatus, topAbsentees] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='present') as present, COUNT(*) FILTER (WHERE status='absent') as absent, COUNT(*) FILTER (WHERE status='late') as late, COUNT(*) FILTER (WHERE status='half_day') as half_day, AVG(working_hours) FILTER (WHERE working_hours > 0) as avg_hours FROM attendance WHERE TO_CHAR(date,'YYYY-MM')=$1`, [month]),
      query(`SELECT status, COUNT(*) as count FROM attendance WHERE TO_CHAR(date,'YYYY-MM')=$1 GROUP BY status ORDER BY count DESC`, [month]),
      query(`SELECT u.first_name, u.last_name, u.employee_id, COUNT(*) as absent_days FROM attendance a JOIN users u ON u.id=a.user_id WHERE a.status='absent' AND TO_CHAR(a.date,'YYYY-MM')=$1 GROUP BY u.id, u.first_name, u.last_name, u.employee_id ORDER BY absent_days DESC LIMIT 5`, [month]),
    ]);
    return sendSuccess(res, { summary: summary.rows[0], byStatus: byStatus.rows, topAbsentees: topAbsentees.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/attendance/check-in:
 *   post:
 *     summary: User manual check-in
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Checked in
 */
const checkIn = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toISOString();
    const r = await query(
      `INSERT INTO attendance (user_id, date, check_in, status) VALUES ($1,$2,$3,'present')
       ON CONFLICT (user_id, date) DO UPDATE SET check_in=EXCLUDED.check_in RETURNING *`,
      [req.user.id, today, now]
    );
    return sendSuccess(res, r.rows[0], 'Checked in successfully');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/attendance/check-out:
 *   post:
 *     summary: User manual check-out
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Checked out
 */
const checkOut = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await query(
      `UPDATE attendance SET check_out=NOW(),
         working_hours = EXTRACT(EPOCH FROM (NOW()-check_in))/3600
       WHERE user_id=$1 AND date=$2 RETURNING *`,
      [req.user.id, today]
    );
    if (!r.rows.length) return sendError(res, 'No check-in found for today', 404);
    return sendSuccess(res, r.rows[0], 'Checked out successfully');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/attendance/my:
 *   get:
 *     summary: Get my attendance history
 *     tags: [Attendance]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Personal attendance history
 */
const getMyAttendance = async (req, res) => {
  try {
    const rows = await query(
      `SELECT * FROM attendance WHERE user_id=$1 ORDER BY date DESC LIMIT 60`,
      [req.user.id]
    );
    const todayRow = await query(
      `SELECT * FROM attendance WHERE user_id=$1 AND date=NOW()::date`,
      [req.user.id]
    );
    return sendSuccess(res, { records: rows.rows, today: todayRow.rows[0] || null });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

module.exports = { getAttendance, markAttendance, getAttendanceStats, checkIn, checkOut, getMyAttendance };
