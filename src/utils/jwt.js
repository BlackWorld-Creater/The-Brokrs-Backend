const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const generateTokens = (payload) => {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    issuer: 'erp-admin',
    audience: 'erp-client',
  });

  const refreshToken = jwt.sign(
    { userId: payload.userId },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
      issuer: 'erp-admin',
      audience: 'erp-client',
    }
  );

  return { accessToken, refreshToken };
};

const verifyAccessToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET, {
    issuer: 'erp-admin',
    audience: 'erp-client',
  });
};

const verifyRefreshToken = (token) => {
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
    issuer: 'erp-admin',
    audience: 'erp-client',
  });
};

const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const generateResetToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const getTokenExpiry = (expiresIn) => {
  const units = { m: 60, h: 3600, d: 86400 };
  const match = expiresIn.match(/^(\d+)([mhd])$/);
  if (!match) return 15 * 60 * 1000;
  return parseInt(match[1]) * units[match[2]] * 1000;
};

module.exports = {
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  generateResetToken,
  getTokenExpiry,
};
