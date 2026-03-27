const { query } = require('../config/database');
const { sendSuccess, sendError } = require('../utils/helpers');

/* ─── Helper: load all email settings from DB ────────────────────── */
const loadEmailConfig = async () => {
  const rows = await query(
    `SELECT key, value FROM settings WHERE group_name='email'`
  );
  const cfg = {};
  rows.rows.forEach(r => { cfg[r.key] = r.value || ''; });
  return cfg;
};

/* ─── Helper: build nodemailer transporter ───────────────────────── */
const buildTransporter = (cfg) => {
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch { throw new Error('nodemailer is not installed. Run: npm install nodemailer'); }

  const port   = parseInt(cfg.smtp_port) || 587;
  const secure = cfg.smtp_secure === 'true' || port === 465;

  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port,
    secure,
    // STARTTLS options for port 587
    ...(!secure && {
      requireTLS: true,           // force STARTTLS upgrade
      tls: {
        rejectUnauthorized: false // allow self-signed / sandbox certs
      },
    }),
    // Direct SSL options for port 465
    ...(secure && {
      tls: { rejectUnauthorized: false }
    }),
    auth: {
      user: cfg.smtp_user,
      pass: cfg.smtp_password,
    },
    // Debug: log everything to console
    logger:  process.env.NODE_ENV !== 'production',
    debug:   process.env.NODE_ENV !== 'production',
    connectionTimeout: 15000,
    greetingTimeout:   10000,
    socketTimeout:     20000,
  });
};

/**
 * @swagger
 * tags:
 *   name: Email
 *   description: SMTP configuration and system emails
 */

/**
 * @swagger
 * /api/email-settings:
 *   get:
 *     summary: Get email server settings
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Email settings retrieved
 */
const getEmailSettings = async (req, res) => {
  try {
    const rows = await query(
      `SELECT key, value, type, description FROM settings WHERE group_name='email' ORDER BY key`
    );
    const settings = {};
    for (const r of rows.rows) {
      settings[r.key] = {
        value:       r.type === 'password' ? (r.value ? '••••••••' : '') : (r.value || ''),
        type:        r.type,
        description: r.description,
      };
    }
    return sendSuccess(res, settings);
  } catch (err) {
    return sendError(res, 'Failed to fetch email settings', 500);
  }
};

/* ─── PUT /api/email-settings ────────────────────────────────────── */
/**
 * @swagger
 * /api/email-settings:
 *   put:
 *     summary: Update SMTP and email settings
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Settings updated
 */
const saveEmailSettings = async (req, res) => {
  const { settings } = req.body;
  try {
    const saved = [];
    for (const [key, value] of Object.entries(settings || {})) {
      if (!key.startsWith('smtp_') && !key.startsWith('email_')) continue;
      if (key === 'smtp_password' && value === '••••••••') continue; // unchanged mask
      const r = await query(
        `UPDATE settings SET value=$1, updated_by=$2 WHERE key=$3 RETURNING key`,
        [String(value ?? ''), req.user.id, key]
      );
      if (r.rows.length) saved.push(key);
    }
    return sendSuccess(res, { saved }, `Saved ${saved.length} setting(s)`);
  } catch (err) {
    console.error('saveEmailSettings error:', err);
    return sendError(res, 'Failed to save settings', 500);
  }
};

/**
 * @swagger
 * /api/email-settings/test-connection:
 *   post:
 *     summary: Test SMTP connection
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Connection successful
 */
const testEmailConnection = async (req, res) => {
  try {
    const cfg = await loadEmailConfig();

    // Detailed validation
    const missing = [];
    if (!cfg.smtp_host)     missing.push('SMTP Host');
    if (!cfg.smtp_user)     missing.push('SMTP Username');
    if (!cfg.smtp_password) missing.push('SMTP Password');
    if (missing.length) {
      return sendError(res, `Missing required fields: ${missing.join(', ')}`, 400);
    }

    const transporter = buildTransporter(cfg);

    // verify() checks the connection AND auth
    await transporter.verify();

    return sendSuccess(res, {
      connected: true,
      host: cfg.smtp_host,
      port: cfg.smtp_port,
      user: cfg.smtp_user,
    }, `✅ SMTP connection successful! Connected to ${cfg.smtp_host}:${cfg.smtp_port}`);

  } catch (err) {
    console.error('[SMTP TEST]', err.message);

    // Give actionable error messages
    let friendlyMsg = err.message;
    if (err.message.includes('wrong version number') || err.message.includes('SSL'))
      friendlyMsg = `SSL/TLS mismatch. If using port 587, turn OFF "Use SSL/TLS". If using port 465, turn it ON.`;
    else if (err.message.includes('ECONNREFUSED'))
      friendlyMsg = `Connection refused. Check the SMTP host and port are correct.`;
    else if (err.message.includes('ETIMEDOUT') || err.message.includes('timeout'))
      friendlyMsg = `Connection timed out. The SMTP server may be blocking your IP, or host/port is wrong.`;
    else if (err.message.includes('535') || err.message.includes('Invalid credentials') || err.message.includes('auth'))
      friendlyMsg = `Authentication failed. Check username and password. For Gmail, use an App Password.`;
    else if (err.message.includes('ENOTFOUND'))
      friendlyMsg = `SMTP host not found: "${cfg.smtp_host}". Check the hostname is correct.`;
    else if (err.message.includes('534') || err.message.includes('less secure'))
      friendlyMsg = `Gmail requires an App Password. Go to Google Account → Security → App Passwords.`;

    return sendError(res, `SMTP connection failed: ${friendlyMsg}`, 400);
  }
};

/**
 * @swagger
 * /api/email-settings/send-test:
 *   post:
 *     summary: Send test email to verify config
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Test email sent
 */
const sendTestEmail = async (req, res) => {
  const { toEmail } = req.body;
  if (!toEmail) return sendError(res, 'Recipient email is required', 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail))
    return sendError(res, 'Invalid email address format', 400);

  try {
    const cfg = await loadEmailConfig();

    const missing = [];
    if (!cfg.smtp_host)     missing.push('SMTP Host');
    if (!cfg.smtp_user)     missing.push('SMTP Username');
    if (!cfg.smtp_password) missing.push('SMTP Password');
    if (missing.length) {
      return sendError(res, `SMTP not configured. Missing: ${missing.join(', ')}. Save settings first.`, 400);
    }

    // Determine the from address.
    // Never use smtp_user as from when it's a sandbox/provider domain (mailtrap, sendgrid, etc.)
    // Mailtrap requires the from address to be something YOU own, e.g. test@example.com
    const BLOCKED_FROM_DOMAINS = ['mailtrap.io', 'sendgrid.net', 'mailgun.org', 'amazonses.com'];
    const userDomain = cfg.smtp_user?.split('@')[1] || '';
    const userIsBlockedDomain = BLOCKED_FROM_DOMAINS.some(d => userDomain.includes(d));

    let fromEmail = cfg.smtp_from_email?.trim();
    if (!fromEmail || userIsBlockedDomain && fromEmail === cfg.smtp_user) {
      // For Mailtrap sandbox, use a safe default that won't be rejected
      fromEmail = userIsBlockedDomain ? 'noreply@example.com' : cfg.smtp_user;
    }
    const fromName  = cfg.smtp_from_name?.trim()  || 'Admin Panel';
    const fromField = `"${fromName}" <${fromEmail}>`;

    console.log(`[SEND TEST] to=${toEmail} from=${fromField} host=${cfg.smtp_host}:${cfg.smtp_port}`);

    const transporter = buildTransporter(cfg);

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;padding:40px 16px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:16px;border:1px solid #2a2a3c;overflow:hidden">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1e1e3a,#2a2a4a);padding:32px 32px 24px">
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:44px;height:44px;background:rgba(99,102,241,0.2);border-radius:10px;text-align:center;vertical-align:middle;font-size:22px">⚡</td>
              <td style="padding-left:12px">
                <div style="font-size:18px;font-weight:700;color:#a5b4fc">Admin Panel</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px">Email Configuration Test</div>
              </td>
            </tr>
          </table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px">
          <h2 style="margin:0 0 16px;font-size:22px;color:#f1f5f9">✅ Your email is working!</h2>
          <p style="margin:0 0 20px;color:#94a3b8;line-height:1.7;font-size:15px">
            This test email confirms your SMTP configuration is set up correctly and emails will be delivered to recipients.
          </p>
          <!-- Config box -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;border-radius:10px;border:1px solid #2a2a3c;margin-bottom:24px">
            <tr><td style="padding:20px">
              <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#6366f1;margin-bottom:12px">SMTP Configuration</div>
              <table cellpadding="0" cellspacing="0" width="100%">
                ${[
                  ['Host', cfg.smtp_host],
                  ['Port', cfg.smtp_port],
                  ['Security', cfg.smtp_secure === 'true' ? 'SSL/TLS (port 465)' : 'STARTTLS (port 587)'],
                  ['From', fromField],
                  ['Sent To', toEmail],
                ].map(([k,v]) => `
                <tr>
                  <td style="padding:4px 0;font-size:13px;color:#64748b;width:80px">${k}</td>
                  <td style="padding:4px 0;font-size:13px;color:#e2e8f0;font-family:monospace">${v}</td>
                </tr>`).join('')}
              </table>
            </td></tr>
          </table>
          <p style="margin:0;font-size:14px;color:#475569;line-height:1.6">
            You can now enable email notifications in the <strong style="color:#a5b4fc">Notifications</strong> tab of Email Settings to start sending alerts for tasks, leave requests, and more.
          </p>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:16px 32px;border-top:1px solid #2a2a3c;text-align:center">
          <p style="margin:0;font-size:12px;color:#334155">
            Sent from <strong style="color:#6366f1">Admin Panel</strong> · ${new Date().toLocaleString()}
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const info = await transporter.sendMail({
      from:    fromField,
      to:      toEmail,
      subject: '✅ Test Email — Admin Panel SMTP Working',
      html,
      text:    `This is a test email from Admin Panel. SMTP Host: ${cfg.smtp_host}:${cfg.smtp_port}. Sent to: ${toEmail}`,
    });

    console.log(`[SEND TEST] ✅ messageId=${info.messageId} response=${info.response}`);

    // Log success
    await query(
      `INSERT INTO email_logs (to_email, subject, template, status, sent_by)
       VALUES ($1,$2,'test','sent',$3)`,
      [toEmail, '✅ Test Email — Admin Panel SMTP Working', req.user.id]
    ).catch(e => console.error('email_log insert failed:', e.message));

    return sendSuccess(res, {
      to:        toEmail,
      from:      fromField,
      messageId: info.messageId,
      response:  info.response,
    }, `✅ Test email sent to ${toEmail}! Check your inbox (or spam folder).`);

  } catch (err) {
    console.error('[SEND TEST ERROR]', err);

    // Log failure
    await query(
      `INSERT INTO email_logs (to_email, subject, template, status, error, sent_by)
       VALUES ($1,$2,'test','failed',$3,$4)`,
      [toEmail, 'Test Email', err.message, req.user.id]
    ).catch(() => {});

    // Friendly errors
    let msg = err.message;
    if (err.message.includes('535') || err.message.includes('auth'))
      msg = 'Authentication failed — check username/password. Gmail needs an App Password.';
    else if (err.message.includes('wrong version') || err.message.includes('SSL'))
      msg = 'SSL error — make sure "Use SSL/TLS" is OFF for port 587, ON for port 465.';
    else if (err.message.includes('ECONNREFUSED'))
      msg = 'Connection refused — check host and port.';
    else if (err.message.includes('ENOTFOUND'))
      msg = `Host not found: "${req.body.host || 'smtp host'}" — check the hostname.`;
    else if (err.message.includes('421') || err.message.includes('450'))
      msg = 'Sending rate limited or blocked by server. Try again in a few minutes.';

    return sendError(res, `Failed to send: ${msg}`, 400);
  }
};

/* ─── GET /api/email-settings/logs ──────────────────────────────── */
/**
 * @swagger
 * /api/email-settings/logs:
 *   get:
 *     summary: Get system email delivery logs
 *     tags: [Email]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Logs retrieved
 */
const getEmailLogs = async (req, res) => {
  try {
    const rows = await query(
      `SELECT el.*, u.first_name, u.last_name
       FROM email_logs el
       LEFT JOIN users u ON u.id=el.sent_by
       ORDER BY el.sent_at DESC LIMIT 50`
    ).catch(() => ({ rows: [] }));
    return sendSuccess(res, rows.rows);
  } catch (err) {
    return sendError(res, 'Failed', 500);
  }
};

/**
 * @swagger
 * /api/user-dashboard:
 *   get:
 *     summary: Get comprehensive user dashboard data
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data found
 */
const getUserDashboard = async (req, res) => {
  const uid = req.user.id;
  try {
    const [myTasks, myAttendance, myLeave, myNotifs, myProfile, recentActivity] = await Promise.all([
      query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE status='todo')        as todo,
          COUNT(*) FILTER (WHERE status='in_progress') as in_progress,
          COUNT(*) FILTER (WHERE status='in_review')   as in_review,
          COUNT(*) FILTER (WHERE status='done')        as done,
          COUNT(*) FILTER (WHERE status='blocked')     as blocked,
          COUNT(*) FILTER (WHERE due_date < NOW()::date AND status NOT IN ('done','cancelled')) as overdue,
          COUNT(*) FILTER (WHERE due_date = NOW()::date AND status NOT IN ('done','cancelled')) as due_today
        FROM tasks WHERE assigned_to=$1 AND status != 'cancelled'
      `, [uid]),
      query(`
        SELECT COUNT(*) as total_days,
          COUNT(*) FILTER (WHERE status='present')  as present,
          COUNT(*) FILTER (WHERE status='absent')   as absent,
          COUNT(*) FILTER (WHERE status='late')     as late,
          ROUND(AVG(working_hours) FILTER (WHERE working_hours>0)::numeric, 1) as avg_hours,
          (SELECT row_to_json(a) FROM (
            SELECT check_in, check_out, status, working_hours
            FROM attendance WHERE user_id=$1 AND date=NOW()::date LIMIT 1
          ) a) as today
        FROM attendance WHERE user_id=$1 AND TO_CHAR(date,'YYYY-MM')=TO_CHAR(NOW(),'YYYY-MM')
      `, [uid]),
      query(`
        SELECT leave_type,
          SUM(days_count) FILTER (WHERE status='approved') as used,
          COUNT(*) FILTER (WHERE status='pending') as pending_count
        FROM leave_requests WHERE user_id=$1
          AND EXTRACT(YEAR FROM from_date)=EXTRACT(YEAR FROM NOW())
        GROUP BY leave_type
      `, [uid]),
      query(`
        SELECT COUNT(*) as unread,
          (SELECT json_agg(n ORDER BY n.created_at DESC) FROM (
            SELECT id, title, message, type, link, is_read, created_at FROM notifications
            WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5
          ) n) as recent
        FROM notifications WHERE user_id=$1 AND is_read=false
      `, [uid]),
      query(`
        SELECT u.first_name, u.last_name, u.email, u.employee_id, u.designation,
               u.status, u.last_login, u.created_at, u.avatar_url,
               d.name as department_name,
               array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL) as roles
        FROM users u
        LEFT JOIN departments d ON d.id=u.department_id
        LEFT JOIN user_roles ur ON ur.user_id=u.id
        LEFT JOIN roles r ON r.id=ur.role_id
        WHERE u.id=$1 GROUP BY u.id, d.name
      `, [uid]),
      query(`
        SELECT action, entity_type, created_at
        FROM audit_logs WHERE user_id=$1
        ORDER BY created_at DESC LIMIT 8
      `, [uid]),
    ]);

    const upcomingTasks = await query(`
      SELECT t.id, t.title, t.status, t.priority, t.due_date::text,
             p.name as project_name
      FROM tasks t LEFT JOIN projects p ON p.id=t.project_id
      WHERE t.assigned_to=$1
        AND t.status NOT IN ('done','cancelled')
        AND t.due_date BETWEEN NOW()::date AND NOW()::date + INTERVAL '7 days'
      ORDER BY t.due_date ASC LIMIT 5
    `, [uid]);

    return sendSuccess(res, {
      profile:        myProfile.rows[0],
      tasks:          myTasks.rows[0],
      attendance:     myAttendance.rows[0],
      leaveBalance:   myLeave.rows,
      notifications:  myNotifs.rows[0],
      upcomingTasks:  upcomingTasks.rows,
      recentActivity: recentActivity.rows,
    });
  } catch (err) {
    console.error('getUserDashboard error:', err);
    return sendError(res, 'Failed to fetch dashboard data', 500);
  }
};

module.exports = {
  getEmailSettings, saveEmailSettings,
  testEmailConnection, sendTestEmail, getEmailLogs,
  getUserDashboard,
};
