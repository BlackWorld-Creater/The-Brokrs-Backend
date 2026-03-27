const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');
const notif = require('../utils/notificationService');

/* ── helpers ─────────────────────────────────────────────────────── */
const actorName = (user) => `${user.first_name} ${user.last_name}`;

const FULL_TASK_QUERY = `
  SELECT t.*,
    t.due_date::text as due_date,
    u1.first_name as assignee_first, u1.last_name as assignee_last,
    u1.email as assignee_email, u1.avatar_url as assignee_avatar,
    u2.first_name as assigner_first, u2.last_name as assigner_last,
    u2.email as assigner_email,
    p.name as project_name, p.code as project_code,
    d.name as department_name
  FROM tasks t
  LEFT JOIN users u1 ON u1.id = t.assigned_to
  LEFT JOIN users u2 ON u2.id = t.assigned_by
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN departments d ON d.id = t.department_id
`;

/**
 * @swagger
 * tags:
 *   name: Tasks
 *   description: Task tracking and assignment system
 */

/**
 * @swagger
 * /api/tasks:
 *   get:
 *     summary: Get all tasks
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of tasks retrieved successfully
 */
const getTasks = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const { status, priority, assignedTo, assignedBy, projectId, search, myTasks, overdue } = req.query;

    const conds = ['1=1'], params = [];
    let idx = 1;

    if (myTasks === 'true') {
      conds.push(`(t.assigned_to=$${idx} OR t.assigned_by=$${idx})`);
      params.push(req.user.id); idx++;
    }
    if (assignedTo)  { conds.push(`t.assigned_to=$${idx++}`);    params.push(assignedTo); }
    if (assignedBy)  { conds.push(`t.assigned_by=$${idx++}`);    params.push(assignedBy); }
    if (status)      { conds.push(`t.status=$${idx++}`);         params.push(status); }
    if (priority)    { conds.push(`t.priority=$${idx++}`);       params.push(priority); }
    if (projectId)   { conds.push(`t.project_id=$${idx++}`);     params.push(projectId); }
    if (overdue === 'true') {
      conds.push(`t.due_date < NOW()::date AND t.status NOT IN ('done','cancelled')`);
    }
    if (search) {
      conds.push(`t.title ILIKE $${idx++}`);
      params.push(`%${search}%`);
    }

    const where = conds.join(' AND ');
    const countRes = await query(`SELECT COUNT(*) FROM tasks t WHERE ${where}`, params);
    const rows = await query(
      `${FULL_TASK_QUERY} WHERE ${where} ORDER BY
        CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
        t.due_date ASC NULLS LAST, t.created_at DESC
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...params, limit, offset]
    );
    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0].count, page, limit));
  } catch (err) {
    console.error('getTasks error:', err);
    return sendError(res, 'Failed to fetch tasks', 500);
  }
};

/**
 * @swagger
 * /api/tasks/stats:
 *   get:
 *     summary: Get task stats
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stats retrieved successfully
 */
const getTaskStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const [overall, mine, overdue, dueSoon] = await Promise.all([
      query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status='todo')        as todo,
          COUNT(*) FILTER (WHERE status='in_progress') as in_progress,
          COUNT(*) FILTER (WHERE status='in_review')   as in_review,
          COUNT(*) FILTER (WHERE status='done')        as done,
          COUNT(*) FILTER (WHERE status='blocked')     as blocked,
          COUNT(*) FILTER (WHERE priority='urgent')    as urgent
        FROM tasks WHERE status != 'cancelled'
      `),
      query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE status='todo')        as todo,
          COUNT(*) FILTER (WHERE status='in_progress') as in_progress,
          COUNT(*) FILTER (WHERE status='done')        as done
        FROM tasks WHERE assigned_to=$1 AND status != 'cancelled'
      `, [userId]),
      query(`
        SELECT COUNT(*) as total FROM tasks
        WHERE due_date < NOW()::date AND status NOT IN ('done','cancelled')
          AND (assigned_to=$1 OR assigned_by=$1)
      `, [userId]),
      query(`
        SELECT COUNT(*) as total FROM tasks
        WHERE due_date = (NOW()::date + INTERVAL '1 day') AND status NOT IN ('done','cancelled')
          AND assigned_to=$1
      `, [userId]),
    ]);
    return sendSuccess(res, {
      overall: overall.rows[0],
      mine:    mine.rows[0],
      overdue: parseInt(overdue.rows[0].total),
      dueSoon: parseInt(dueSoon.rows[0].total),
    });
  } catch (err) {
    return sendError(res, 'Failed to fetch stats', 500);
  }
};

/**
 * @swagger
 * /api/tasks/{id}:
 *   get:
 *     summary: Get task by ID
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Task found
 */
const getTaskById = async (req, res) => {
  try {
    const r = await query(`${FULL_TASK_QUERY} WHERE t.id=$1`, [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Task not found', 404);

    // Fetch comments
    const comments = await query(
      `SELECT c.*, u.first_name, u.last_name, u.email, u.avatar_url
       FROM task_comments c JOIN users u ON u.id=c.user_id
       WHERE c.task_id=$1 ORDER BY c.created_at ASC`,
      [req.params.id]
    );

    return sendSuccess(res, { ...r.rows[0], comments: comments.rows });
  } catch (err) {
    return sendError(res, 'Failed to fetch task', 500);
  }
};

/**
 * @swagger
 * /api/tasks:
 *   post:
 *     summary: Create new task
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Task created successfully
 */
const createTask = async (req, res) => {
  const d = req.body;
  try {
    if (!d.title?.trim()) return sendError(res, 'Title is required', 400);

    const r = await query(
      `INSERT INTO tasks
        (title, description, assigned_to, assigned_by, status, priority,
         due_date, estimated_hours, tags, project_id, department_id, watcher_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        d.title.trim(), d.description || null,
        d.assignedTo || null, req.user.id,
        d.status || 'todo', d.priority || 'medium',
        d.dueDate || null, d.estimatedHours || null,
        d.tags || [], d.projectId || null, d.departmentId || null,
        d.watcherIds || [],
      ]
    );
    const task = r.rows[0];

    /* ── Fire notification if task is assigned to someone ── */
    if (d.assignedTo && d.assignedTo !== req.user.id) {
      await notif.taskAssigned({
        task,
        assignedTo:   d.assignedTo,
        assignedBy:   req.user.id,
        assignerName: actorName(req.user),
      });
    }

    await auditLog({
      userId: req.user.id, action: 'CREATE', entityType: 'task', entityId: task.id,
      newValues: { title: task.title, assignedTo: d.assignedTo, priority: task.priority },
      req,
    });

    return sendSuccess(res, task, 'Task created', 201);
  } catch (err) {
    console.error('createTask error:', err);
    return sendError(res, err.message || 'Failed to create task', 500);
  }
};

/**
 * @swagger
 * /api/tasks/{id}:
 *   put:
 *     summary: Update task
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Task updated
 */
const updateTask = async (req, res) => {
  const { id } = req.params;
  const d = req.body;
  try {
    const old = await query(`${FULL_TASK_QUERY} WHERE t.id=$1`, [id]);
    if (!old.rows.length) return sendError(res, 'Task not found', 404);
    const oldTask = old.rows[0];

    const completedAt = d.status === 'done' && oldTask.status !== 'done' ? 'NOW()' : oldTask.completed_at ? `'${oldTask.completed_at}'` : 'NULL';
    const completedBy = d.status === 'done' && oldTask.status !== 'done' ? req.user.id : oldTask.completed_by;

    const r = await query(
      `UPDATE tasks SET
        title=$1, description=$2, assigned_to=$3, status=$4, priority=$5,
        due_date=$6, estimated_hours=$7, actual_hours=$8, tags=$9,
        project_id=$10, department_id=$11, watcher_ids=$12,
        completed_at=${completedAt}, completed_by=$13
       WHERE id=$14 RETURNING *`,
      [
        d.title, d.description || null, d.assignedTo || null,
        d.status || oldTask.status, d.priority || oldTask.priority,
        d.dueDate || null, d.estimatedHours || null, d.actualHours || null,
        d.tags || [], d.projectId || null, d.departmentId || null,
        d.watcherIds || [], completedBy, id,
      ]
    );
    const updatedTask = { ...r.rows[0], watcher_ids: r.rows[0].watcher_ids || [] };

    /* ── Fire notifications based on what changed ── */

    // 1. Assignee changed
    if (d.assignedTo && d.assignedTo !== oldTask.assigned_to) {
      await notif.taskReassigned({
        task: updatedTask,
        oldAssigneeId: oldTask.assigned_to,
        newAssigneeId: d.assignedTo,
        actorId:       req.user.id,
        actorName:     actorName(req.user),
      });
    } else if (!oldTask.assigned_to && d.assignedTo) {
      // Was unassigned, now assigned
      await notif.taskAssigned({
        task: updatedTask,
        assignedTo:   d.assignedTo,
        assignedBy:   req.user.id,
        assignerName: actorName(req.user),
      });
    }

    // 2. Status changed
    if (d.status && d.status !== oldTask.status) {
      await notif.taskStatusChanged({
        task:      { ...updatedTask, assigned_by: oldTask.assigned_by, watcher_ids: d.watcherIds || [] },
        oldStatus: oldTask.status,
        newStatus:  d.status,
        actorId:    req.user.id,
        actorName:  actorName(req.user),
      });
    }

    await auditLog({
      userId: req.user.id, action: 'UPDATE', entityType: 'task', entityId: id,
      oldValues: { status: oldTask.status, assignedTo: oldTask.assigned_to, priority: oldTask.priority },
      newValues: { status: d.status, assignedTo: d.assignedTo, priority: d.priority },
      req,
    });

    return sendSuccess(res, updatedTask, 'Task updated');
  } catch (err) {
    console.error('updateTask error:', err);
    return sendError(res, 'Failed to update task', 500);
  }
};

/**
 * @swagger
 * /api/tasks/{id}:
 *   delete:
 *     summary: Delete task
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Task deleted
 */
const deleteTask = async (req, res) => {
  try {
    const r = await query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Task not found', 404);
    await query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
    await auditLog({ userId: req.user.id, action: 'DELETE', entityType: 'task', entityId: req.params.id, req });
    return sendSuccess(res, {}, 'Task deleted');
  } catch (err) {
    return sendError(res, 'Failed to delete task', 500);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/comments:
 *   post:
 *     summary: Add comment to task
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { comment: { type: string } } }
 *     responses:
 *       201:
 *         description: Comment added
 */
const addComment = async (req, res) => {
  const { comment } = req.body;
  try {
    if (!comment?.trim()) return sendError(res, 'Comment cannot be empty', 400);

    const taskRes = await query(`${FULL_TASK_QUERY} WHERE t.id=$1`, [req.params.id]);
    if (!taskRes.rows.length) return sendError(res, 'Task not found', 404);
    const task = taskRes.rows[0];

    const r = await query(
      `INSERT INTO task_comments (task_id, user_id, comment) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, req.user.id, comment.trim()]
    );

    // Notify everyone involved
    await notif.taskCommentAdded({
      task,
      comment:   comment.trim(),
      actorId:   req.user.id,
      actorName: actorName(req.user),
    });

    return sendSuccess(res, {
      ...r.rows[0],
      first_name: req.user.first_name,
      last_name:  req.user.last_name,
      email:      req.user.email,
    }, 'Comment added', 201);
  } catch (err) {
    console.error('addComment error:', err);
    return sendError(res, 'Failed to add comment', 500);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/comments/{commentId}:
 *   delete:
 *     summary: Delete a comment
 *     tags: [Tasks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: commentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Comment deleted
 */
const deleteComment = async (req, res) => {
  try {
    const r = await query(
      `DELETE FROM task_comments WHERE id=$1 AND (user_id=$2 OR $3=true) RETURNING id`,
      [req.params.commentId, req.user.id, req.user.roles?.includes('admin')]
    );
    if (!r.rows.length) return sendError(res, 'Comment not found or unauthorized', 403);
    return sendSuccess(res, {}, 'Comment deleted');
  } catch (err) {
    return sendError(res, 'Failed to delete comment', 500);
  }
};

/**
 * @swagger
 * /api/tasks/{id}/status:
 *   patch:
 *     summary: Quick status update
 *     tags: [Tasks]
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
const updateStatus = async (req, res) => {
  const { status } = req.body;
  try {
    const old = await query('SELECT * FROM tasks WHERE id=$1', [req.params.id]);
    if (!old.rows.length) return sendError(res, 'Task not found', 404);

    const isDone = status === 'done';
    const r = await query(
      `UPDATE tasks SET status=$1,
        completed_at = CASE WHEN $2 THEN NOW() ELSE completed_at END,
        completed_by = CASE WHEN $2 THEN $3 ELSE completed_by END
       WHERE id=$4 RETURNING *`,
      [status, isDone, req.user.id, req.params.id]
    );

    if (old.rows[0].status !== status) {
      await notif.taskStatusChanged({
        task:      old.rows[0],
        oldStatus: old.rows[0].status,
        newStatus:  status,
        actorId:    req.user.id,
        actorName:  actorName(req.user),
      });
    }

    return sendSuccess(res, r.rows[0], 'Status updated');
  } catch (err) {
    return sendError(res, 'Failed to update status', 500);
  }
};

module.exports = {
  getTasks, getTaskStats, getTaskById,
  createTask, updateTask, deleteTask,
  addComment, deleteComment, updateStatus,
};
