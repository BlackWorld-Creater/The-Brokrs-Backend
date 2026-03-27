const { query, transaction } = require('../config/database');
const { sendSuccess, sendError, auditLog } = require('../utils/helpers');

/**
 * @swagger
 * tags:
 *   name: Roles
 *   description: Role management and permission control
 */

/**
 * @swagger
 * /api/roles:
 *   get:
 *     summary: Get all roles
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of roles retrieved successfully
 */
const getRoles = async (req, res) => {
  try {
    const rolesRes = await query(
      `SELECT r.*, COUNT(DISTINCT ur.user_id) as user_count
       FROM roles r
       LEFT JOIN user_roles ur ON ur.role_id = r.id
       GROUP BY r.id ORDER BY r.created_at`
    );
    return sendSuccess(res, rolesRes.rows);
  } catch (error) {
    return sendError(res, 'Failed to fetch roles', 500);
  }
};

/**
 * @swagger
 * /api/roles/{id}:
 *   get:
 *     summary: Get role by ID
 *     tags: [Roles]
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
 *         description: Role and its permissions retrieved successfully
 *       404:
 *         description: Role not found
 */
const getRoleById = async (req, res) => {
  try {
    const { id } = req.params;
    const roleRes = await query('SELECT * FROM roles WHERE id = $1', [id]);
    if (!roleRes.rows.length) return sendError(res, 'Role not found', 404);

    const permsRes = await query(
      `SELECT p.*, m.name as module_name, m.slug as module_slug, m.icon
       FROM permissions p
       JOIN modules m ON m.id = p.module_id
       WHERE p.role_id = $1 ORDER BY m.sort_order`,
      [id]
    );

    return sendSuccess(res, { ...roleRes.rows[0], permissions: permsRes.rows });
  } catch (error) {
    return sendError(res, 'Failed to fetch role', 500);
  }
};

/**
 * @swagger
 * /api/roles:
 *   post:
 *     summary: Create new role
 *     tags: [Roles]
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
 *               permissions: { type: array, items: { type: object } }
 *     responses:
 *       201:
 *         description: Role created successfully
 *       409:
 *         description: Role already exists
 */
const createRole = async (req, res) => {
  const { name, description, permissions } = req.body;
  try {
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const exists = await query('SELECT id FROM roles WHERE slug = $1', [slug]);
    if (exists.rows.length) return sendError(res, 'Role with similar name already exists', 409);

    const result = await transaction(async (client) => {
      const roleRes = await client.query(
        'INSERT INTO roles (name, slug, description) VALUES ($1,$2,$3) RETURNING *',
        [name, slug, description]
      );
      const role = roleRes.rows[0];

      if (permissions?.length) {
        for (const p of permissions) {
          await client.query(
            `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
            [role.id, p.moduleId, p.permissionType, p.isGranted !== false]
          );
        }
      }
      return role;
    });

    await auditLog({ userId: req.user.id, action: 'CREATE', entityType: 'role', entityId: result.id, newValues: { name }, req });
    return sendSuccess(res, result, 'Role created successfully', 201);
  } catch (error) {
    console.error('Create role error:', error);
    return sendError(res, 'Failed to create role', 500);
  }
};

/**
 * @swagger
 * /api/roles/{id}:
 *   put:
 *     summary: Update role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               isActive: { type: boolean }
 *               permissions: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Role updated successfully
 *       403:
 *         description: Cannot modify system roles
 *       404:
 *         description: Role not found
 */
const updateRole = async (req, res) => {
  const { id } = req.params;
  const { name, description, isActive, permissions } = req.body;

  try {
    const roleRes = await query('SELECT * FROM roles WHERE id = $1', [id]);
    if (!roleRes.rows.length) return sendError(res, 'Role not found', 404);
    if (roleRes.rows[0].is_system) return sendError(res, 'Cannot modify system roles', 403);

    await transaction(async (client) => {
      await client.query(
        'UPDATE roles SET name=$1, description=$2, is_active=$3 WHERE id=$4',
        [name, description, isActive, id]
      );

      if (permissions !== undefined) {
        await client.query('DELETE FROM permissions WHERE role_id = $1', [id]);
        for (const p of permissions) {
          await client.query(
            `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
             VALUES ($1,$2,$3,$4)`,
            [id, p.moduleId, p.permissionType, p.isGranted !== false]
          );
        }
      }
    });

    const updatedRole = await query('SELECT * FROM roles WHERE id=$1', [id]);
    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'role', entityId: id,
      oldValues: { name: roleRes.rows[0].name, description: roleRes.rows[0].description, isActive: roleRes.rows[0].is_active },
      newValues: { name, description, isActive },
      req });
    return sendSuccess(res, {}, 'Role updated successfully');
  } catch (error) {
    console.error('Update role error:', error);
    return sendError(res, 'Failed to update role', 500);
  }
};

/**
 * @swagger
 * /api/roles/{id}:
 *   delete:
 *     summary: Delete role
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Role deleted successfully
 */
const deleteRole = async (req, res) => {
  const { id } = req.params;
  try {
    const roleRes = await query('SELECT * FROM roles WHERE id = $1', [id]);
    if (!roleRes.rows.length) return sendError(res, 'Role not found', 404);
    if (roleRes.rows[0].is_system) return sendError(res, 'Cannot delete system roles', 403);

    const usersWithRole = await query('SELECT COUNT(*) FROM user_roles WHERE role_id = $1', [id]);
    if (parseInt(usersWithRole.rows[0].count) > 0) {
      return sendError(res, 'Cannot delete role assigned to users', 400);
    }

    await query('DELETE FROM roles WHERE id = $1', [id]);
    await auditLog({ userId: req.user.id, action: 'DELETE', entityType: 'role', entityId: id, req });
    return sendSuccess(res, {}, 'Role deleted successfully');
  } catch (error) {
    return sendError(res, 'Failed to delete role', 500);
  }
};

/**
 * @swagger
 * /api/modules:
 *   get:
 *     summary: Get all active modules
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of modules
 */
const getModules = async (req, res) => {
  try {
    const modsRes = await query('SELECT * FROM modules WHERE is_active = true ORDER BY sort_order');
    return sendSuccess(res, modsRes.rows);
  } catch (error) {
    return sendError(res, 'Failed to fetch modules', 500);
  }
};

/**
 * @swagger
 * /api/roles/{roleId}/permissions:
 *   put:
 *     summary: Bulk update role permissions
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Permissions updated successfully
 */
const updateRolePermissions = async (req, res) => {
  const { roleId } = req.params;
  const { permissions } = req.body; // Array of { moduleId, permissionType, isGranted }

  try {
    const roleRes = await query('SELECT * FROM roles WHERE id = $1', [roleId]);
    if (!roleRes.rows.length) return sendError(res, 'Role not found', 404);
    if (roleRes.rows[0].is_system && !req.user.roles.includes('super-admin')) {
      return sendError(res, 'Only super admin can modify system role permissions', 403);
    }

    await transaction(async (client) => {
      for (const p of permissions) {
        await client.query(
          `INSERT INTO permissions (role_id, module_id, permission_type, is_granted)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (role_id, module_id, permission_type)
           DO UPDATE SET is_granted = $4, updated_at = NOW()`,
          [roleId, p.moduleId, p.permissionType, p.isGranted]
        );
      }
    });

    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'permissions', entityId: roleId, newValues: { permissions }, req });
    return sendSuccess(res, {}, 'Permissions updated successfully');
  } catch (error) {
    console.error('Update permissions error:', error);
    return sendError(res, 'Failed to update permissions', 500);
  }
};

module.exports = { getRoles, getRoleById, createRole, updateRole, deleteRole, getModules, updateRolePermissions };
