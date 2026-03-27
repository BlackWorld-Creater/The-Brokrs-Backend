const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, sendPaginated, auditLog, getPagination, buildPaginationMeta } = require('../utils/helpers');

const safeQuery = async (sql, params = []) => {
  try { return await query(sql, params); }
  catch (err) {
    if (err.code === '42P01') return { rows: [], rowCount: 0 };
    throw err;
  }
};

/**
 * @swagger
 * tags:
 *   name: Verticals
 *   description: Business vertical management and member assignment
 */

/**
 * @swagger
 * /api/verticals:
 *   get:
 *     summary: Get all verticals
 *     tags: [Verticals]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of verticals retrieved successfully
 */
const getVerticals = async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const search = req.query.search || '';
    const params = search ? [`%${search}%`] : [];
    const where  = search ? `WHERE v.name ILIKE $1 OR v.description ILIKE $1` : '';

    const countRes = await safeQuery(`SELECT COUNT(*) FROM verticals v ${where}`, params);
    const rows = await safeQuery(
      `SELECT v.*,
              COALESCE((SELECT COUNT(*) FROM vertical_members vm WHERE vm.vertical_id = v.id), 0) as member_count,
              u.first_name as creator_first, u.last_name as creator_last
       FROM verticals v
       LEFT JOIN users u ON u.id = v.created_by
       ${where}
       GROUP BY v.id, u.first_name, u.last_name
       ORDER BY v.sort_order, v.name
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return sendPaginated(res, rows.rows, buildPaginationMeta(countRes.rows[0]?.count || 0, page, limit));
  } catch (err) {
    console.error('Get verticals error:', err);
    return sendError(res, 'Failed to fetch verticals', 500);
  }
};

/**
 * @swagger
 * /api/verticals/{id}:
 *   get:
 *     summary: Get vertical by ID
 *     tags: [Verticals]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Vertical details and members
 */
const getVerticalById = async (req, res) => {
  try {
    const r = await safeQuery(
      `SELECT v.*, COALESCE((SELECT COUNT(*) FROM vertical_members vm WHERE vm.vertical_id = v.id),0) as member_count
       FROM verticals v WHERE v.id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return sendError(res, 'Vertical not found', 404);

    const members = await safeQuery(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.avatar_url,
              vm.role, d.name as department
       FROM vertical_members vm
       JOIN users u ON u.id=vm.user_id
       LEFT JOIN departments d ON d.id=u.department_id
       WHERE vm.vertical_id=$1`,
      [req.params.id]
    );
    return sendSuccess(res, { ...r.rows[0], members: members.rows });
  } catch (err) {
    return sendError(res, 'Failed to fetch vertical', 500);
  }
};

/**
 * @swagger
 * /api/verticals:
 *   post:
 *     summary: Create vertical
 *     tags: [Verticals]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               icon: { type: string }
 *               color: { type: string }
 *     responses:
 *       201:
 *         description: Vertical created
 */
const createVertical = async (req, res) => {
  const { name, description, icon, color, sortOrder, memberIds, isActive } = req.body;
  try {
    if (!name?.trim()) return sendError(res, 'Name is required', 400);
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const exists = await query('SELECT id FROM verticals WHERE slug=$1 OR name=$2', [slug, name.trim()]);
    if (exists.rows.length) return sendError(res, 'A vertical with this name already exists', 409);

    const result = await transaction(async (client) => {
      const r = await client.query(
        `INSERT INTO verticals (name, slug, description, icon, color, sort_order, is_active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [name.trim(), slug, description, icon || 'Layers', color || '#6366f1',
         parseInt(sortOrder) || 0, isActive !== false, req.user.id]
      );
      const v = r.rows[0];
      if (memberIds?.length) {
        for (const uid of memberIds) {
          await client.query(
            `INSERT INTO vertical_members (vertical_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [v.id, uid]
          );
        }
      }
      return v;
    });

    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'vertical',
                     entityId: result.id, newValues: { name }, req });
    return sendSuccess(res, result, 'Vertical created', 201);
  } catch (err) {
    console.error('Create vertical error:', err);
    return sendError(res, err.message || 'Failed to create vertical', 500);
  }
};

/**
 * @swagger
 * /api/verticals/{id}:
 *   put:
 *     summary: Update vertical
 *     tags: [Verticals]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Vertical updated
 */
const updateVertical = async (req, res) => {
  const { id } = req.params;
  const { name, description, icon, color, sortOrder, isActive, memberIds } = req.body;
  try {
    const exists = await query('SELECT id FROM verticals WHERE id=$1', [id]);
    if (!exists.rows.length) return sendError(res, 'Vertical not found', 404);

    await transaction(async (client) => {
      await client.query(
        `UPDATE verticals SET name=$1, description=$2, icon=$3, color=$4,
         sort_order=$5, is_active=$6 WHERE id=$7`,
        [name, description, icon, color, parseInt(sortOrder) || 0, isActive !== false, id]
      );
      if (memberIds !== undefined) {
        await client.query('DELETE FROM vertical_members WHERE vertical_id=$1', [id]);
        for (const uid of memberIds) {
          await client.query(
            `INSERT INTO vertical_members (vertical_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [id, uid]
          );
        }
      }
    });

    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'vertical', entityId: id, req });
    return sendSuccess(res, {}, 'Vertical updated');
  } catch (err) {
    console.error('Update vertical error:', err);
    return sendError(res, 'Failed to update vertical', 500);
  }
};

/**
 * @swagger
 * /api/verticals/{id}:
 *   delete:
 *     summary: Delete vertical
 *     tags: [Verticals]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Vertical deleted
 */
const deleteVertical = async (req, res) => {
  try {
    const r = await query('SELECT id, name FROM verticals WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return sendError(res, 'Vertical not found', 404);
    await query('DELETE FROM verticals WHERE id=$1', [req.params.id]);
    await auditLog({ userId: req.user.id, action: 'DELETE', entityType: 'vertical',
                     entityId: req.params.id, req });
    return sendSuccess(res, {}, 'Vertical deleted');
  } catch (err) {
    return sendError(res, 'Failed to delete vertical', 500);
  }
};

module.exports = { getVerticals, getVerticalById, createVertical, updateVertical, deleteVertical };
