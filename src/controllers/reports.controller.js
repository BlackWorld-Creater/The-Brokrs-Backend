const { query } = require('../config/database');
const { sendSuccess, sendError } = require('../utils/helpers');

/**
 * @swagger
 * tags:
 *   name: Reports
 *   description: Business Intelligence and System Analytic Reports
 */

/**
 * @swagger
 * /api/reports/headcount:
 *   get:
 *     summary: Headcount and employee status report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Report generated
 */
const getHeadcountReport = async (req, res) => {
  try {
    const [total, byDept, byStatus, monthly] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='active') as active FROM users`),
      query(`SELECT d.name as department, COUNT(u.id) as count FROM departments d LEFT JOIN users u ON u.department_id=d.id AND u.status='active' GROUP BY d.id, d.name ORDER BY count DESC`),
      query(`SELECT status, COUNT(*) as count FROM users GROUP BY status`),
      query(`SELECT TO_CHAR(date_of_joining,'YYYY-MM') as month, COUNT(*) as hires FROM users WHERE date_of_joining >= NOW()-INTERVAL '12 months' GROUP BY month ORDER BY month`),
    ]);
    return sendSuccess(res, { total: total.rows[0], byDepartment: byDept.rows, byStatus: byStatus.rows, monthlyHires: monthly.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/reports/attendance:
 *   get:
 *     summary: Attendance trend report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Report generated
 */
const getAttendanceReport = async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0,7);
  try {
    const [summary, byEmployee, daily] = await Promise.all([
      query(`SELECT COUNT(*) as total_records, COUNT(*) FILTER (WHERE status='present') as present, COUNT(*) FILTER (WHERE status='absent') as absent, COUNT(*) FILTER (WHERE status='late') as late, AVG(working_hours) FILTER (WHERE working_hours>0) as avg_hours FROM attendance WHERE TO_CHAR(date,'YYYY-MM')=$1`, [month]),
      query(`SELECT u.first_name, u.last_name, u.employee_id, d.name as dept, COUNT(*) FILTER (WHERE a.status='present') as present, COUNT(*) FILTER (WHERE a.status='absent') as absent, COUNT(*) FILTER (WHERE a.status='late') as late, ROUND(AVG(a.working_hours) FILTER (WHERE a.working_hours>0)::numeric,2) as avg_hours FROM attendance a JOIN users u ON u.id=a.user_id LEFT JOIN departments d ON d.id=u.department_id WHERE TO_CHAR(a.date,'YYYY-MM')=$1 GROUP BY u.id, u.first_name, u.last_name, u.employee_id, d.name ORDER BY u.first_name LIMIT 50`, [month]),
      query(`SELECT date, COUNT(*) FILTER (WHERE status='present') as present, COUNT(*) FILTER (WHERE status='absent') as absent FROM attendance WHERE TO_CHAR(date,'YYYY-MM')=$1 GROUP BY date ORDER BY date`, [month]),
    ]);
    return sendSuccess(res, { month, summary: summary.rows[0], byEmployee: byEmployee.rows, daily: daily.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/reports/leave:
 *   get:
 *     summary: Leave request analytics report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Report generated
 */
const getLeaveReport = async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  try {
    const [byType, byDept, monthly] = await Promise.all([
      query(`SELECT leave_type, COUNT(*) as requests, SUM(days_count) as total_days, COUNT(*) FILTER (WHERE status='approved') as approved FROM leave_requests WHERE EXTRACT(YEAR FROM from_date)=$1 GROUP BY leave_type ORDER BY total_days DESC`, [year]),
      query(`SELECT d.name as department, COUNT(lr.id) as requests, SUM(lr.days_count) as total_days FROM leave_requests lr JOIN users u ON u.id=lr.user_id LEFT JOIN departments d ON d.id=u.department_id WHERE EXTRACT(YEAR FROM lr.from_date)=$1 AND lr.status='approved' GROUP BY d.name ORDER BY total_days DESC`, [year]),
      query(`SELECT TO_CHAR(from_date,'YYYY-MM') as month, COUNT(*) as requests, SUM(days_count) as days FROM leave_requests WHERE EXTRACT(YEAR FROM from_date)=$1 AND status='approved' GROUP BY month ORDER BY month`, [year]),
    ]);
    return sendSuccess(res, { year, byType: byType.rows, byDepartment: byDept.rows, monthly: monthly.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/reports/tasks:
 *   get:
 *     summary: Task completion and efficiency report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Report generated
 */
const getTasksReport = async (req, res) => {
  try {
    const [byStatus, byPriority, byUser, completion] = await Promise.all([
      query(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status ORDER BY count DESC`),
      query(`SELECT priority, COUNT(*) as count FROM tasks WHERE status!='cancelled' GROUP BY priority ORDER BY count DESC`),
      query(`SELECT u.first_name, u.last_name, COUNT(*) as total, COUNT(*) FILTER (WHERE t.status='done') as done, COUNT(*) FILTER (WHERE t.status='in_progress') as in_progress FROM tasks t JOIN users u ON u.id=t.assigned_to WHERE t.assigned_to IS NOT NULL GROUP BY u.id, u.first_name, u.last_name ORDER BY total DESC LIMIT 10`),
      query(`SELECT TO_CHAR(completed_at,'YYYY-MM') as month, COUNT(*) as completed FROM tasks WHERE status='done' AND completed_at >= NOW()-INTERVAL '6 months' GROUP BY month ORDER BY month`),
    ]);
    return sendSuccess(res, { byStatus: byStatus.rows, byPriority: byPriority.rows, byUser: byUser.rows, completionTrend: completion.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/reports/projects:
 *   get:
 *     summary: Project status and budget usage report
 *     tags: [Reports]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Report generated
 */
const getProjectsReport = async (req, res) => {
  try {
    const [byStatus, budget, timeline] = await Promise.all([
      query(`SELECT status, COUNT(*) as count, AVG(progress) as avg_progress FROM projects GROUP BY status`),
      query(`SELECT name, budget, spent, CASE WHEN budget>0 THEN ROUND((spent/budget*100)::numeric,1) ELSE 0 END as spent_pct FROM projects WHERE budget IS NOT NULL ORDER BY spent_pct DESC LIMIT 10`),
      query(`SELECT name, start_date, end_date, status, progress FROM projects WHERE start_date IS NOT NULL ORDER BY start_date DESC LIMIT 20`),
    ]);
    return sendSuccess(res, { byStatus: byStatus.rows, budgetUsage: budget.rows, timeline: timeline.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

module.exports = { getHeadcountReport, getAttendanceReport, getLeaveReport, getTasksReport, getProjectsReport };
