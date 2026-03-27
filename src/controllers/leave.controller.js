const { query } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');
const notif = require('../utils/notificationService');

const LEAVE_TYPES = ['casual','sick','earned','maternity','paternity','unpaid','comp_off'];

/**
 * @swagger
 * tags:
 *   name: Leave
 *   description: Employee leave requests and balances
 */

/**
 * @swagger
 * /api/leave/requests:
 *   get:
 *     summary: Get all leave requests
 *     tags: [Leave]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of leave requests retrieved successfully
 */
const getLeaveRequests = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { userId, status, leaveType, from, to, myTeam } = req.query;
    const conds = ['1=1'], params = [];
    let idx = 1;
    if (userId)    { conds.push(`lr.user_id=$${idx++}`);        params.push(userId); }
    if (status)    { conds.push(`lr.status=$${idx++}`);         params.push(status); }
    if (leaveType) { conds.push(`lr.leave_type=$${idx++}`);     params.push(leaveType); }
    if (from)      { conds.push(`lr.from_date >= $${idx++}`);   params.push(from); }
    if (to)        { conds.push(`lr.to_date <= $${idx++}`);     params.push(to); }
    if (myTeam === 'true') {
      conds.push(`u.department_id IN (SELECT department_id FROM users WHERE id=$${idx++})`);
      params.push(req.user.id);
    }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM leave_requests lr JOIN users u ON u.id=lr.user_id WHERE ${where}`, params);
    const rows = await query(
      `SELECT lr.*, u.first_name, u.last_name, u.employee_id, u.avatar_url,
              d.name as department_name,
              a.first_name as approver_first, a.last_name as approver_last
       FROM leave_requests lr
       JOIN users u ON u.id=lr.user_id
       LEFT JOIN departments d ON d.id=u.department_id
       LEFT JOIN users a ON a.id=lr.approved_by
       WHERE ${where} ORDER BY lr.created_at DESC
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/leave/requests:
 *   post:
 *     summary: Submit new leave request
 *     tags: [Leave]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [leaveType, fromDate, toDate]
 *             properties:
 *               leaveType: { type: string, enum: [casual, sick, earned, maternity, paternity, unpaid, comp_off] }
 *               fromDate: { type: string, format: date }
 *               toDate: { type: string, format: date }
 *     responses:
 *       201:
 *         description: Request submitted
 */
const createLeaveRequest = async (req, res) => {
  const { leaveType, fromDate, toDate, reason } = req.body;
  try {
    if (!LEAVE_TYPES.includes(leaveType)) return sendError(res, 'Invalid leave type', 400);
    const from = new Date(fromDate), to = new Date(toDate);
    const daysCount = Math.ceil((to - from) / 86400000) + 1;
    const r = await query(
      `INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, days_count, reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, leaveType, fromDate, toDate, daysCount, reason]
    );
    // Notify HR Manager / approvers
    const hrs = await query(`SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE r.slug IN ('hr-manager','admin','super-admin') AND u.status='active'`);
    await notif.sendToMany(hrs.rows.map(h => h.id), {
      title: '📅 New Leave Request',
      message: `${req.user.first_name} ${req.user.last_name} applied for ${daysCount} day(s) ${leaveType} leave`,
      type: 'info', link: '/leave', entityType: 'leave_request', entityId: r.rows[0].id, actorId: req.user.id,
    });
    return sendSuccess(res, r.rows[0], 'Leave request submitted', 201);
  } catch (err) { console.error(err); return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/leave/requests/{id}/status:
 *   put:
 *     summary: Update leave request status (Approve/Reject)
 *     tags: [Leave]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Status updated
 */
const updateLeaveStatus = async (req, res) => {
  const { id } = req.params;
  const { status, rejectionReason } = req.body;
  try {
    const old = await query('SELECT lr.*, u.first_name, u.last_name FROM leave_requests lr JOIN users u ON u.id=lr.user_id WHERE lr.id=$1', [id]);
    if (!old.rows.length) return sendError(res, 'Leave request not found', 404);
    if (!['approved','rejected','cancelled'].includes(status)) return sendError(res, 'Invalid status', 400);
    await query(
      `UPDATE leave_requests SET status=$1, approved_by=$2, approved_at=NOW(), rejection_reason=$3 WHERE id=$4`,
      [status, req.user.id, rejectionReason || null, id]
    );
    const req_data = old.rows[0];
    await notif.send({
      userId: req_data.user_id,
      title: status === 'approved' ? '✅ Leave Approved' : '❌ Leave Rejected',
      message: status === 'approved'
        ? `Your ${req_data.leave_type} leave (${req_data.days_count} days) has been approved`
        : `Your ${req_data.leave_type} leave was rejected: ${rejectionReason || 'No reason provided'}`,
      type: status === 'approved' ? 'success' : 'warning',
      link: '/leave', entityType: 'leave_request', entityId: id, actorId: req.user.id,
    });
    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'leave_request', entityId: id,
                     oldValues: { status: req_data.status }, newValues: { status }, req });
    return sendSuccess(res, {}, `Leave ${status}`);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/leave/stats:
 *   get:
 *     summary: Get leave analytics and my balance
 *     tags: [Leave]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stats retrieved
 */
const getLeaveStats = async (req, res) => {
  try {
    const [overall, byType, myBalance] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='pending') as pending, COUNT(*) FILTER (WHERE status='approved') as approved, COUNT(*) FILTER (WHERE status='rejected') as rejected FROM leave_requests WHERE EXTRACT(YEAR FROM from_date)=EXTRACT(YEAR FROM NOW())`),
      query(`SELECT leave_type, COUNT(*) as count, SUM(days_count) as total_days FROM leave_requests WHERE status='approved' AND EXTRACT(YEAR FROM from_date)=EXTRACT(YEAR FROM NOW()) GROUP BY leave_type ORDER BY total_days DESC`),
      query(`SELECT leave_type, SUM(days_count) as used FROM leave_requests WHERE user_id=$1 AND status='approved' AND EXTRACT(YEAR FROM from_date)=EXTRACT(YEAR FROM NOW()) GROUP BY leave_type`, [req.user.id]),
    ]);
    return sendSuccess(res, { overall: overall.rows[0], byType: byType.rows, myBalance: myBalance.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/leave/requests/{id}:
 *   delete:
 *     summary: Delete/Cancel leave request
 *     tags: [Leave]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Request cancelled
 */
const deleteLeaveRequest = async (req, res) => {
  try {
    const r = await query('SELECT * FROM leave_requests WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Not found', 404);
    if (r.rows[0].user_id !== req.user.id && !req.user.roles?.includes('admin')) return sendError(res, 'Unauthorized', 403);
    if (r.rows[0].status === 'approved') return sendError(res, 'Cannot delete approved leave', 400);
    await query('DELETE FROM leave_requests WHERE id=$1', [req.params.id]);
    return sendSuccess(res, {}, 'Leave request cancelled');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

module.exports = { getLeaveRequests, createLeaveRequest, updateLeaveStatus, getLeaveStats, deleteLeaveRequest };
