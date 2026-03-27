const { verifyAccessToken, hashToken } = require('../utils/jwt');
const { query } = require('../config/database');
const { sendError } = require('../utils/helpers');

// Verify JWT Access Token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return sendError(res, 'Access token required', 401);
    }

    const token = authHeader.split(' ')[1];

    // Check if token is blacklisted
    const tokenHash = hashToken(token);
    const blacklisted = await query(
      'SELECT id FROM token_blacklist WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash]
    );
    if (blacklisted.rows.length > 0) {
      return sendError(res, 'Token has been revoked', 401);
    }

    const decoded = verifyAccessToken(token);

    // Fetch fresh user data
    const userRes = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.status, u.department_id,
              u.designation, u.avatar_url, u.must_change_password,
              array_agg(DISTINCT r.slug) FILTER (WHERE r.slug IS NOT NULL) as roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id AND r.is_active = true
       WHERE u.id = $1
       GROUP BY u.id`,
      [decoded.userId]
    );

    if (!userRes.rows.length) {
      return sendError(res, 'User not found', 401);
    }

    const user = userRes.rows[0];

    if (user.status !== 'active') {
      return sendError(res, `Account is ${user.status}. Please contact administrator.`, 403);
    }

    req.user = {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      fullName: `${user.first_name} ${user.last_name}`,
      status: user.status,
      roles: user.roles || [],
      departmentId: user.department_id,
      designation: user.designation,
      avatarUrl: user.avatar_url,
      mustChangePassword: user.must_change_password,
    };

    req.token = token;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return sendError(res, 'Access token expired', 401);
    }
    if (error.name === 'JsonWebTokenError') {
      return sendError(res, 'Invalid access token', 401);
    }
    console.error('Auth middleware error:', error);
    return sendError(res, 'Authentication failed', 500);
  }
};

// Check if user has a specific role
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 'Not authenticated', 401);

    const userRoles = req.user.roles || [];
    const hasRole = userRoles.some(role =>
      allowedRoles.includes(role) || userRoles.includes('super-admin')
    );

    if (!hasRole) {
      return sendError(res, 'Insufficient role permissions', 403);
    }
    next();
  };
};

// Check module permission
const requirePermission = (moduleSlug, permissionType) => {
  return async (req, res, next) => {
    try {
      if (!req.user) return sendError(res, 'Not authenticated', 401);

      const userId = req.user.id;
      const userRoles = req.user.roles || [];

      // Super admin bypasses all permission checks
      if (userRoles.includes('super-admin')) return next();

      // Check user-specific permission override first
      const userPermRes = await query(
        `SELECT up.is_granted FROM user_permissions up
         JOIN modules m ON m.id = up.module_id
         WHERE up.user_id = $1 AND m.slug = $2 AND up.permission_type = $3
         AND (up.expires_at IS NULL OR up.expires_at > NOW())`,
        [userId, moduleSlug, permissionType]
      );

      if (userPermRes.rows.length > 0) {
        if (userPermRes.rows[0].is_granted) return next();
        const { auditLog } = require('../utils/helpers');
        await auditLog({ userId, action: 'ACCESS_DENIED', req, metadata: { module: moduleSlug, permission: permissionType } });
        return sendError(res, `Permission denied: ${permissionType} on ${moduleSlug}`, 403);
      }

      // Check role-based permissions
      const rolePermRes = await query(
        `SELECT p.is_granted FROM permissions p
         JOIN modules m ON m.id = p.module_id
         JOIN roles r ON r.id = p.role_id
         JOIN user_roles ur ON ur.role_id = r.id
         WHERE ur.user_id = $1 AND m.slug = $2 AND p.permission_type = $3
         AND r.is_active = true AND m.is_active = true
         AND (ur.expires_at IS NULL OR ur.expires_at > NOW())
         AND p.is_granted = true`,
        [userId, moduleSlug, permissionType]
      );

      if (rolePermRes.rows.some(r => r.is_granted)) return next();

      const { auditLog } = require('../utils/helpers');
      await auditLog({ userId, action: 'ACCESS_DENIED', req, metadata: { module: moduleSlug, permission: permissionType } });
      return sendError(res, `Permission denied: ${permissionType} on ${moduleSlug}`, 403);
    } catch (error) {
      console.error('Permission check error:', error);
      return sendError(res, 'Permission check failed', 500);
    }
  };
};

// Get all user permissions for frontend
const getUserPermissions = async (userId) => {
  const userRolesRes = await query(
    `SELECT r.slug FROM roles r JOIN user_roles ur ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.is_active = true
     AND (ur.expires_at IS NULL OR ur.expires_at > NOW())`,
    [userId]
  );
  const userRoles = userRolesRes.rows.map(r => r.slug);

  if (userRoles.includes('super-admin')) {
    const allModules = await query(`SELECT slug FROM modules WHERE is_active = true`);
    const permissions = {};
    const allPerms = ['create', 'read', 'update', 'delete', 'export', 'import', 'approve', 'manage'];
    for (const { slug } of allModules.rows) {
      permissions[slug] = allPerms;
    }
    return { roles: userRoles, permissions };
  }

  // Role permissions
  const rolePermsRes = await query(
    `SELECT DISTINCT m.slug as module, p.permission_type
     FROM permissions p
     JOIN modules m ON m.id = p.module_id
     JOIN roles r ON r.id = p.role_id
     JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = $1 AND p.is_granted = true
     AND r.is_active = true AND m.is_active = true`,
    [userId]
  );

  // User overrides
  const userPermsRes = await query(
    `SELECT DISTINCT m.slug as module, up.permission_type, up.is_granted
     FROM user_permissions up
     JOIN modules m ON m.id = up.module_id
     WHERE up.user_id = $1 AND (up.expires_at IS NULL OR up.expires_at > NOW())`,
    [userId]
  );

  const permissions = {};
  for (const { module, permission_type } of rolePermsRes.rows) {
    if (!permissions[module]) permissions[module] = [];
    if (!permissions[module].includes(permission_type)) {
      permissions[module].push(permission_type);
    }
  }

  // Apply overrides
  for (const { module, permission_type, is_granted } of userPermsRes.rows) {
    if (!permissions[module]) permissions[module] = [];
    if (is_granted && !permissions[module].includes(permission_type)) {
      permissions[module].push(permission_type);
    } else if (!is_granted) {
      permissions[module] = permissions[module].filter(p => p !== permission_type);
    }
  }

  return { roles: userRoles, permissions };
};

module.exports = { authenticate, requireRole, requirePermission, getUserPermissions };
