const bcrypt = require('bcryptjs');
const { query, transaction } = require('../config/database');
const { generateTokens, verifyRefreshToken, hashToken, getTokenExpiry } = require('../utils/jwt');
const { sendSuccess, sendError, auditLog } = require('../utils/helpers');
const { getUserPermissions } = require('../middleware/auth');

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME = 15 * 60 * 1000;

const extractIP = (req) => {
  const raw =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    '0.0.0.0';
  return raw.replace(/^::ffff:/, '');
};

const parseUserAgent = (ua = '') => {
  let browser = 'Unknown', deviceType = 'Desktop';
  if (!ua) return { browser, deviceType };
  if (/mobile|android|iphone|ipad/i.test(ua)) deviceType = 'Mobile';
  else if (/tablet/i.test(ua)) deviceType = 'Tablet';
  if (/chrome/i.test(ua) && !/edge/i.test(ua)) browser = 'Chrome';
  else if (/firefox/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'Safari';
  else if (/edge/i.test(ua)) browser = 'Edge';
  else if (/msie|trident/i.test(ua)) browser = 'IE';
  return { browser, deviceType };
};

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication and Authorization management
 */

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: User Login
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 *       423:
 *         description: Account locked
 *       500:
 *         description: Server error
 */
const login = async (req, res) => {

  const { email, password } = req.body;
  const ipAddress = extractIP(req);
  const userAgent = req.get('User-Agent') || null;
  const { browser, deviceType } = parseUserAgent(userAgent);

  try {
    const userRes = await query(
      `SELECT id, email, password_hash, first_name, last_name, status,
              login_attempts, locked_until, must_change_password, avatar_url,
              last_login, last_login_ip
       FROM users WHERE email=$1`,
      [email]
    );

    if (!userRes.rows.length) {
      setImmediate(() => query(
        `INSERT INTO ip_tracking (ip_address,user_id,event_type,path,method,user_agent,metadata)
         VALUES ($1,NULL,'login_failed','/api/auth/login','POST',$2,$3)`,
        [ipAddress, userAgent, JSON.stringify({ reason: 'unknown_email', email })]
      ).catch(() => {}));
      return sendError(res, 'Invalid email or password', 401);
    }

    const user = userRes.rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      setImmediate(() => query(
        `INSERT INTO ip_tracking (ip_address,user_id,event_type,path,method,user_agent,metadata)
         VALUES ($1,$2,'login_failed','/api/auth/login','POST',$3,$4)`,
        [ipAddress, user.id, userAgent, JSON.stringify({ reason: 'account_locked' })]
      ).catch(() => {}));
      return sendError(res, `Account locked. Try again in ${minutes} minutes.`, 423);
    }

    if (user.status === 'suspended') return sendError(res, 'Account suspended. Contact administrator.', 403);
    if (user.status === 'inactive')  return sendError(res, 'Account is inactive. Contact administrator.', 403);

    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      const newAttempts = (user.login_attempts || 0) + 1;
      const willLock = newAttempts >= MAX_LOGIN_ATTEMPTS;
      const lockUntil = willLock ? new Date(Date.now() + LOCK_TIME) : null;
      await query(`UPDATE users SET login_attempts=$1, locked_until=$2 WHERE id=$3`, [newAttempts, lockUntil, user.id]);
      setImmediate(() => query(
        `INSERT INTO ip_tracking (ip_address,user_id,event_type,path,method,user_agent,metadata)
         VALUES ($1,$2,'login_failed','/api/auth/login','POST',$3,$4)`,
        [ipAddress, user.id, userAgent, JSON.stringify({ reason: 'wrong_password', attempts: newAttempts })]
      ).catch(() => {}));
      const remaining = MAX_LOGIN_ATTEMPTS - newAttempts;
      return sendError(res,
        remaining > 0
          ? `Invalid password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
          : 'Account locked for 15 minutes due to too many failed attempts.',
        401
      );
    }

    /* ── SUCCESS ── */
    const { roles, permissions } = await getUserPermissions(user.id);
    const tokenPayload = { userId: user.id, email: user.email, roles };
    const { accessToken, refreshToken } = generateTokens(tokenPayload);
    const refreshHash = hashToken(refreshToken);

    /* Save previous login, set new login info */
    await query(
      `UPDATE users
       SET refresh_token_hash=$1, login_attempts=0, locked_until=NULL,
           previous_login=last_login, previous_login_ip=last_login_ip,
           last_login=NOW(), last_login_ip=$2
       WHERE id=$3`,
      [refreshHash, ipAddress, user.id]
    );

    /* Record in login_sessions */
    setImmediate(() => query(
      `INSERT INTO login_sessions
       (user_id, ip_address, user_agent, browser, device_type, is_active)
       VALUES ($1,$2,$3,$4,$5,true)`,
      [user.id, ipAddress, userAgent, browser, deviceType]
    ).catch(() => {}));

    /* Record in ip_tracking */
    setImmediate(() => query(
      `INSERT INTO ip_tracking (ip_address,user_id,event_type,path,method,user_agent,metadata)
       VALUES ($1,$2,'login','/api/auth/login','POST',$3,$4)`,
      [ipAddress, user.id, userAgent, JSON.stringify({ email: user.email, browser, deviceType })]
    ).catch(() => {}));

    await auditLog({
      userId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, req,
      metadata: { email: user.email, ip: ipAddress, browser, deviceType },
    });

    return sendSuccess(res, {
      user: {
        id: user.id, email: user.email,
        firstName: user.first_name, lastName: user.last_name,
        fullName: `${user.first_name} ${user.last_name}`,
        avatarUrl: user.avatar_url,
        mustChangePassword: user.must_change_password,
        lastLogin: user.last_login,
        lastLoginIP: user.last_login_ip,
        roles,
      },
      permissions, accessToken, refreshToken,
    }, 'Login successful');
  } catch (error) {
    console.error('Login error:', error);
    return sendError(res, 'Login failed', 500);
  }
};

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh Access Token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token refreshed
 *       401:
 *         description: Invalid refresh token
 */
const refreshToken = async (req, res) => {
  const { refreshToken: token } = req.body;
  if (!token) return sendError(res, 'Refresh token required', 400);
  try {
    const decoded = verifyRefreshToken(token);
    const tokenHash = hashToken(token);
    const userRes = await query(`SELECT id,email,status,refresh_token_hash FROM users WHERE id=$1`, [decoded.userId]);
    if (!userRes.rows.length) return sendError(res, 'Invalid refresh token', 401);
    const user = userRes.rows[0];
    if (user.refresh_token_hash !== tokenHash) return sendError(res, 'Invalid or reused refresh token', 401);
    if (user.status !== 'active') return sendError(res, 'Account inactive', 403);
    const { roles, permissions } = await getUserPermissions(user.id);
    const tokenPayload = { userId: user.id, email: user.email, roles };
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(tokenPayload);
    const newRefreshHash = hashToken(newRefreshToken);
    await query('UPDATE users SET refresh_token_hash=$1 WHERE id=$2', [newRefreshHash, user.id]);
    return sendSuccess(res, { accessToken, refreshToken: newRefreshToken, permissions }, 'Token refreshed');
  } catch (error) {
    if (error.name === 'TokenExpiredError') return sendError(res, 'Refresh token expired', 401);
    return sendError(res, 'Invalid refresh token', 401);
  }
};

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Logout user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
const logout = async (req, res) => {
  try {
    const tokenHash = hashToken(req.token);
    const expiresAt = new Date(Date.now() + getTokenExpiry(process.env.JWT_EXPIRES_IN || '15m'));
    await query('INSERT INTO token_blacklist (token_hash,user_id,expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [tokenHash, req.user.id, expiresAt]);
    await query('UPDATE users SET refresh_token_hash=NULL WHERE id=$1', [req.user.id]);
    /* close active session */
    setImmediate(() => query(
      `UPDATE login_sessions SET logout_at=NOW(), is_active=false
       WHERE user_id=$1 AND is_active=true AND logout_at IS NULL`,
      [req.user.id]
    ).catch(() => {}));
    await auditLog({ userId: req.user.id, action: 'LOGOUT', entityType: 'user', entityId: req.user.id, req });
    return sendSuccess(res, {}, 'Logged out successfully');
  } catch (error) {
    return sendError(res, 'Logout failed', 500);
  }
};

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current user profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile retrieved successfully
 */
const getMe = async (req, res) => {
  try {
    const userRes = await query(
      `SELECT u.id, u.employee_id, u.first_name, u.last_name, u.email, u.phone,
              u.avatar_url, u.status, u.designation, u.date_of_joining,
              u.last_login, u.last_login_ip, u.previous_login, u.previous_login_ip,
              u.must_change_password, u.two_factor_enabled, u.created_at,
              d.name as department_name, d.id as department_id
       FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.id=$1`,
      [req.user.id]
    );
    if (!userRes.rows.length) return sendError(res, 'User not found', 404);
    const { roles, permissions } = await getUserPermissions(req.user.id);
    return sendSuccess(res, { user: { ...userRes.rows[0], roles }, permissions });
  } catch (error) {
    return sendError(res, 'Failed to get user info', 500);
  }
};

/**
 * @swagger
 * /api/auth/change-password:
 *   put:
 *     summary: Change password
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password changed successfully
 */
const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    const userRes = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    if (!userRes.rows.length) return sendError(res, 'User not found', 404);
    const isValid = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
    if (!isValid) return sendError(res, 'Current password is incorrect', 400);
    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash=$1, must_change_password=false WHERE id=$2', [newHash, req.user.id]);
    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'user', entityId: req.user.id, req,
                     metadata: { action: 'password_change' } });
    return sendSuccess(res, {}, 'Password changed successfully');
  } catch (error) {
    return sendError(res, 'Failed to change password', 500);
  }
};

/**
 * @swagger
 * /api/auth/profile:
 *   put:
 *     summary: Update profile
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profile updated
 */
const updateProfile = async (req, res) => {
  const { firstName, lastName, phone, designation, address, city, country, timezone } = req.body;
  try {
    const r = await query(
      `UPDATE users SET first_name=$1,last_name=$2,phone=$3,designation=$4,
       address=$5,city=$6,country=$7,timezone=$8 WHERE id=$9
       RETURNING id, first_name, last_name, email, phone, designation, avatar_url`,
      [firstName, lastName, phone, designation, address, city, country, timezone, req.user.id]
    );
    await auditLog({ userId: req.user.id, action: 'UPDATE', entityType: 'user', entityId: req.user.id, req,
                     metadata: { action: 'profile_update' } });
    return sendSuccess(res, r.rows[0], 'Profile updated successfully');
  } catch (error) {
    return sendError(res, 'Failed to update profile', 500);
  }
};

module.exports = { login, refreshToken, logout, getMe, changePassword, updateProfile };
