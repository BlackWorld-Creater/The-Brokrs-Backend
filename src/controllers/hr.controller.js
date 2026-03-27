const { query } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');

/* ── Employee Profile ────────────────────────────────────────────── */
/**
 * @swagger
 * tags:
 *   name: HR
 *   description: Human Resource and Employee management
 */

/**
 * @swagger
 * /api/hr/employees:
 *   get:
 *     summary: Get all employee profiles
 *     tags: [HR]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of employees retrieved successfully
 */
const getEmployees = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { search, departmentId, status } = req.query;
    const conds = ['1=1'], params = [];
    let idx = 1;
    if (search) { conds.push(`(u.first_name ILIKE $${idx} OR u.last_name ILIKE $${idx} OR u.email ILIKE $${idx} OR u.employee_id ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (departmentId) { conds.push(`u.department_id=$${idx++}`); params.push(departmentId); }
    if (status) { conds.push(`u.status=$${idx++}`); params.push(status); }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM users u WHERE ${where}`, params);
    const rows = await query(
      `SELECT u.id, u.employee_id, u.first_name, u.last_name, u.email, u.phone,
              u.status, u.designation, u.date_of_joining, u.date_of_birth,
              u.avatar_url, u.created_at,
              d.name as department_name,
              ep.blood_group, ep.marital_status, ep.salary_ctc, ep.bank_name,
              array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL) as roles
       FROM users u
       LEFT JOIN departments d ON d.id=u.department_id
       LEFT JOIN employee_profiles ep ON ep.user_id=u.id
       LEFT JOIN user_roles ur ON ur.user_id=u.id
       LEFT JOIN roles r ON r.id=ur.role_id
       WHERE ${where}
       GROUP BY u.id, d.name, ep.blood_group, ep.marital_status, ep.salary_ctc, ep.bank_name
       ORDER BY u.first_name
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { console.error(err); return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/hr/employees/{id}:
 *   get:
 *     summary: Get detailed employee profile
 *     tags: [HR]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Employee profile found
 */
const getEmployeeById = async (req, res) => {
  try {
    const r = await query(
      `SELECT u.*, d.name as department_name,
              ep.*,
              array_agg(DISTINCT jsonb_build_object('id',r.id,'name',r.name)) FILTER (WHERE r.id IS NOT NULL) as roles
       FROM users u
       LEFT JOIN departments d ON d.id=u.department_id
       LEFT JOIN employee_profiles ep ON ep.user_id=u.id
       LEFT JOIN user_roles ur ON ur.user_id=u.id
       LEFT JOIN roles r ON r.id=ur.role_id
       WHERE u.id=$1 GROUP BY u.id, d.name, ep.id`,
      [req.params.id]
    );
    if (!r.rows.length) return sendError(res, 'Employee not found', 404);
    return sendSuccess(res, r.rows[0]);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/hr/employees/{id}/profile:
 *   put:
 *     summary: Update/Upsert employee HR profile
 *     tags: [HR]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Profile updated
 */
const upsertEmployeeProfile = async (req, res) => {
  const d = req.body;
  try {
    await query(
      `INSERT INTO employee_profiles
         (user_id, emergency_contact_name, emergency_contact_phone, blood_group,
          marital_status, nationality, pan_number, aadhar_number,
          bank_account, bank_name, bank_ifsc, salary_ctc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (user_id) DO UPDATE SET
         emergency_contact_name=$2, emergency_contact_phone=$3, blood_group=$4,
         marital_status=$5, nationality=$6, pan_number=$7, aadhar_number=$8,
         bank_account=$9, bank_name=$10, bank_ifsc=$11, salary_ctc=$12`,
      [req.params.id, d.emergencyContactName, d.emergencyContactPhone, d.bloodGroup,
       d.maritalStatus, d.nationality, d.panNumber, d.aadharNumber,
       d.bankAccount, d.bankName, d.bankIfsc, d.salaryCTC || null]
    );
    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'employee_profile', entityId: req.params.id, req });
    return sendSuccess(res, {}, 'Profile updated');
  } catch (err) { console.error(err); return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/hr/stats:
 *   get:
 *     summary: Get HR department stats
 *     tags: [HR]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: HR stats retrieved successfully
 */
const getHRStats = async (req, res) => {
  try {
    const [emp, dept, newHires, leaving] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='active') as active, COUNT(*) FILTER (WHERE status='inactive') as inactive, COUNT(*) FILTER (WHERE status='suspended') as suspended FROM users`),
      query(`SELECT d.name, COUNT(u.id) as count FROM departments d LEFT JOIN users u ON u.department_id=d.id AND u.status='active' GROUP BY d.id, d.name ORDER BY count DESC LIMIT 5`),
      query(`SELECT COUNT(*) as count FROM users WHERE date_of_joining >= NOW()-INTERVAL '30 days' AND status='active'`),
      query(`SELECT COUNT(*) as count FROM users WHERE status='inactive' AND updated_at >= NOW()-INTERVAL '30 days'`),
    ]);
    return sendSuccess(res, {
      employees: emp.rows[0],
      byDepartment: dept.rows,
      newHires30d: parseInt(newHires.rows[0].count),
      recentLeaving: parseInt(leaving.rows[0].count),
    });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

module.exports = { getEmployees, getEmployeeById, upsertEmployeeProfile, getHRStats };
