const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, auditLog } = require('../utils/helpers');

/**
 * @swagger
 * tags:
 *   name: Modules
 *   description: System module manager and permission tracking
 */

/**
 * @swagger
 * /api/modules/manage:
 *   get:
 *     summary: Get all system modules
 *     tags: [Modules]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of modules with role counts
 */
const getAllModules = async (req, res) => {
  try {
    const rows = await query(
      `SELECT m.*,
              COUNT(DISTINCT p.role_id) FILTER (WHERE p.is_granted = true) as role_count
       FROM modules m
       LEFT JOIN permissions p ON p.module_id = m.id
       GROUP BY m.id
       ORDER BY m.sort_order, m.name`
    );
    return sendSuccess(res, rows.rows);
  } catch (err) {
    console.error(err);
    return sendError(res, 'Failed to fetch modules', 500);
  }
};

/**
 * @swagger
 * /api/modules/manage:
 *   post:
 *     summary: Create new system module
 *     tags: [Modules]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug]
 *             properties:
 *               name: { type: string }
 *               slug: { type: string }
 *               description: { type: string }
 *               category: { type: string }
 *     responses:
 *       201:
 *         description: Module created successfully
 */
const createModule = async (req, res) => {
  const { name, slug, description, icon, isActive, sortOrder, category, version, config } = req.body;
  try {
    if (!name || !slug) return sendError(res, 'name and slug are required', 400);

    const slugClean = slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const exists = await query('SELECT id FROM modules WHERE slug=$1', [slugClean]);
    if (exists.rows.length) return sendError(res, 'A module with this slug already exists', 409);

    const r = await query(
      `INSERT INTO modules (name, slug, description, icon, is_active, sort_order, category, version, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, slugClean, description, icon || 'Package',
       isActive !== false, sortOrder || 99, category || 'custom',
       version || '1.0.0', JSON.stringify(config || {})]
    );

    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'module', entityId: r.rows[0].id,
                     newValues: { name, slug: slugClean }, req });
    return sendSuccess(res, r.rows[0], 'Module created', 201);
  } catch (err) {
    console.error(err);
    return sendError(res, 'Failed to create module', 500);
  }
};

/**
 * @swagger
 * /api/modules/manage/{id}:
 *   put:
 *     summary: Update system module
 *     tags: [Modules]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Module updated
 */
const updateModule = async (req, res) => {
  const { id } = req.params;
  const { name, description, icon, isActive, sortOrder, category, version, config } = req.body;
  try {
    const exists = await query('SELECT id FROM modules WHERE id=$1', [id]);
    if (!exists.rows.length) return sendError(res, 'Module not found', 404);

    await query(
      `UPDATE modules SET name=$1, description=$2, icon=$3, is_active=$4,
       sort_order=$5, category=$6, version=$7, config=$8 WHERE id=$9`,
      [name, description, icon, isActive, sortOrder, category,
       version, JSON.stringify(config || {}), id]
    );

    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'module', entityId: id, req });
    return sendSuccess(res, {}, 'Module updated');
  } catch (err) {
    console.error(err);
    return sendError(res, 'Failed to update module', 500);
  }
};

/**
 * @swagger
 * /api/modules/manage/{id}/toggle:
 *   put:
 *     summary: Toggle module active state
 *     tags: [Modules]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Module toggled
 */
const toggleModule = async (req, res) => {
  try {
    const r = await query(
      `UPDATE modules SET is_active = NOT is_active WHERE id=$1 RETURNING id, name, is_active`,
      [req.params.id]
    );
    if (!r.rows.length) return sendError(res, 'Module not found', 404);
    const { name, is_active } = r.rows[0];
    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'module',
                     entityId: req.params.id, newValues: { is_active }, req });
    return sendSuccess(res, r.rows[0], `Module "${name}" ${is_active ? 'enabled' : 'disabled'}`);
  } catch (err) {
    return sendError(res, 'Failed to toggle module', 500);
  }
};

/**
 * @swagger
 * /api/modules/manage/{id}/permissions:
 *   get:
 *     summary: Get module permissions by role
 *     tags: [Modules]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of roles and their permissions for this module
 */
const getModulePermissions = async (req, res) => {
  try {
    const rows = await query(
      `SELECT r.id as role_id, r.name as role_name, r.slug as role_slug,
              array_agg(p.permission_type ORDER BY p.permission_type)
                FILTER (WHERE p.is_granted = true) as granted_permissions
       FROM roles r
       LEFT JOIN permissions p ON p.role_id=r.id AND p.module_id=$1
       WHERE r.is_active=true
       GROUP BY r.id ORDER BY r.name`,
      [req.params.id]
    );
    return sendSuccess(res, rows.rows);
  } catch (err) {
    return sendError(res, 'Failed to fetch module permissions', 500);
  }
};

module.exports = { getAllModules, createModule, updateModule, toggleModule, getModulePermissions };
