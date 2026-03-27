const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');
const notif = require('../utils/notificationService');

/**
 * @swagger
 * tags:
 *   name: Projects
 *   description: Software and business project tracking
 */

/**
 * @swagger
 * /api/projects:
 *   get:
 *     summary: Get all projects
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of projects retrieved successfully
 */
const getProjects = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { search, status, priority, managerId } = req.query;
    const conds = ['1=1'], params = []; let idx = 1;
    if (search)    { conds.push(`(p.name ILIKE $${idx} OR p.code ILIKE $${idx} OR p.client_name ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (status)    { conds.push(`p.status=$${idx++}`);     params.push(status); }
    if (priority)  { conds.push(`p.priority=$${idx++}`);   params.push(priority); }
    if (managerId) { conds.push(`p.manager_id=$${idx++}`); params.push(managerId); }
    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM projects p WHERE ${where}`, params);
    const rows = await query(
      `SELECT p.*, m.first_name as mgr_first, m.last_name as mgr_last,
              d.name as department_name,
              (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id=p.id) as member_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) as task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='done') as done_tasks
       FROM projects p
       LEFT JOIN users m ON m.id=p.manager_id
       LEFT JOIN departments d ON d.id=p.department_id
       WHERE ${where}
       ORDER BY CASE p.status WHEN 'active' THEN 1 WHEN 'planning' THEN 2 ELSE 3 END, p.created_at DESC
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) { console.error(err); return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/projects/{id}:
 *   get:
 *     summary: Get project by ID
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Project details, members and tasks
 */
const getProjectById = async (req, res) => {
  try {
    const r = await query(
      `SELECT p.*, m.first_name as mgr_first, m.last_name as mgr_last
       FROM projects p LEFT JOIN users m ON m.id=p.manager_id WHERE p.id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return sendError(res, 'Project not found', 404);
    const [members, tasks] = await Promise.all([
      query(`SELECT pm.*, u.first_name, u.last_name, u.email, u.avatar_url, u.designation FROM project_members pm JOIN users u ON u.id=pm.user_id WHERE pm.project_id=$1`, [req.params.id]),
      query(`SELECT t.*, u.first_name as assignee_first, u.last_name as assignee_last FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.project_id=$1 ORDER BY t.status, t.due_date LIMIT 20`, [req.params.id]),
    ]);
    return sendSuccess(res, { ...r.rows[0], members: members.rows, tasks: tasks.rows });
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/projects:
 *   post:
 *     summary: Create new project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Project created
 */
const createProject = async (req, res) => {
  const d = req.body;
  try {
    const r = await transaction(async (client) => {
      const proj = await client.query(
        `INSERT INTO projects (name, code, description, client_name, status, priority,
           start_date, end_date, budget, manager_id, department_id, progress, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [d.name, d.code, d.description, d.clientName, d.status||'planning', d.priority||'medium',
         d.startDate||null, d.endDate||null, d.budget||null, d.managerId||null,
         d.departmentId||null, d.progress||0, req.user.id]
      );
      if (d.memberIds?.length) {
        for (const uid of d.memberIds) {
          await client.query(`INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING`, [proj.rows[0].id, uid]);
        }
      }
      return proj.rows[0];
    });
    // Notify manager if different from creator
    if (d.managerId && d.managerId !== req.user.id) {
      await notif.send({
        userId: d.managerId, title: '📁 Project assigned to you',
        message: `You are the manager of new project: "${d.name}"`,
        type: 'info', link: `/projects/${r.id}`, entityType: 'project', entityId: r.id, actorId: req.user.id,
      });
    }
    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'project', entityId: r.id, newValues: { name: d.name }, req });
    return sendSuccess(res, r, 'Project created', 201);
  } catch (err) { console.error(err); return sendError(res, err.message||'Failed', 500); }
};

/**
 * @swagger
 * /api/projects/{id}:
 *   put:
 *     summary: Update project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Project updated
 */
const updateProject = async (req, res) => {
  const { id } = req.params;
  const d = req.body;
  try {
    const old = await query('SELECT * FROM projects WHERE id=$1', [id]);
    if (!old.rows.length) return sendError(res, 'Project not found', 404);
    await query(
      `UPDATE projects SET name=$1, description=$2, client_name=$3, status=$4, priority=$5,
         start_date=$6, end_date=$7, budget=$8, spent=$9, manager_id=$10,
         department_id=$11, progress=$12, is_active=$13 WHERE id=$14`,
      [d.name, d.description, d.clientName, d.status, d.priority,
       d.startDate||null, d.endDate||null, d.budget||null, d.spent||0,
       d.managerId||null, d.departmentId||null, d.progress||0, d.isActive!==false, id]
    );
    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'project', entityId: id,
                     oldValues: { status: old.rows[0].status, progress: old.rows[0].progress },
                     newValues: { status: d.status, progress: d.progress }, req });
    return sendSuccess(res, {}, 'Project updated');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/projects/{id}:
 *   delete:
 *     summary: Delete project
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Project deleted
 */
const deleteProject = async (req, res) => {
  try {
    const r = await query('SELECT id, name FROM projects WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Project not found', 404);
    await query('DELETE FROM projects WHERE id=$1', [req.params.id]);
    return sendSuccess(res, {}, 'Project deleted');
  } catch (err) { return sendError(res, 'Failed', 500); }
};

/**
 * @swagger
 * /api/projects/stats:
 *   get:
 *     summary: Get project analytics
 *     tags: [Projects]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stats retrieved successfully
 */
const getProjectStats = async (req, res) => {
  try {
    const stats = await query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE status='active')    as active,
        COUNT(*) FILTER (WHERE status='planning')  as planning,
        COUNT(*) FILTER (WHERE status='completed') as completed,
        COUNT(*) FILTER (WHERE status='on_hold')   as on_hold,
        AVG(progress) as avg_progress,
        SUM(budget) as total_budget, SUM(spent) as total_spent
      FROM projects WHERE is_active=true
    `);
    return sendSuccess(res, stats.rows[0]);
  } catch (err) { return sendError(res, 'Failed', 500); }
};

module.exports = { getProjects, getProjectById, createProject, updateProject, deleteProject, getProjectStats };
