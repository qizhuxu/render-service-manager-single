/**
 * Render Service Manager - Single File Cloudflare Worker
 * 
 * 由 render-service-manager 项目打包而成
 * 无需构建步骤，直接使用 wrangler deploy 部署
 * 
 * Source: https://github.com/ssfun/render-service-manager
 */

// ============================================================================
// Section 1: 应用常量配置 (config/constants.js)
// ============================================================================

/**
 * 应用常量配置
 */

// 会话配置
const SESSION_CONFIG = {
  EXPIRY: 24 * 60 * 60 * 1000,           // 会话过期时间: 24小时
  MIN_REFRESH_INTERVAL: 5 * 60 * 1000,   // 滑动刷新最小间隔: 5分钟
};

// 缓存配置
const CACHE_CONFIG = {
  SOFT_TTL: 15 * 60 * 1000,       // 软 TTL: 15 分钟（fresh）
  HARD_TTL: 24 * 60 * 60 * 1000,  // 硬 TTL: 24 小时（stale -> expired）
  KV_TTL: 48 * 60 * 60,           // KV 存储 TTL: 48 小时（秒）
  VERSION: 'v1',                   // 缓存版本（数据结构变更时递增）
};

// API 请求配置
const API_CONFIG = {
  TIMEOUT_MS: 15000,         // 请求超时: 15秒
  MAX_ATTEMPTS: 3,           // 最大重试次数
  PAGE_LIMIT: 100,           // 分页大小
};

// Render API 基础地址
const RENDER_API_BASE = 'https://api.render.com/v1';

// KV 存储键
const KV_KEYS = {
  ACCOUNTS: 'render:accounts',
  SESSION_PREFIX: 'session:',
  LOGIN_ATTEMPT_PREFIX: 'login_attempt:',
  SERVICES_CACHE_PREFIX: 'services:',
};

// 登录防暴力配置
const LOGIN_RATE_LIMIT = {
  MAX_ATTEMPTS: 5,
  WINDOW_SECONDS: 15 * 60,
  BASE_LOCK_SECONDS: 5 * 60,
  MAX_LOCK_SECONDS: 60 * 60,
};

// HTTP 状态码
const HTTP_STATUS = {
  OK: 200,
  NO_CONTENT: 204,
  FOUND: 302,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

// Ping 保活配置
const PING_CONFIG = {
  TIMEOUT_MS: 10000,        // 单次请求超时 10s
  MAX_RETRIES: 2,           // 最多重试 2 次
  RETRY_DELAY_MS: 1000,     // 重试基础间隔 1s（使用指数退避）
  BATCH_SIZE: 10,           // 每批并发数（提升性能）
  BATCH_INTERVAL_MS: 100,   // 批次间固定间隔 ms
};

// Cron 任务配置
const CRON_CONFIG = {
  TIMEOUT_MS: 25000,        // Cron 任务超时 25s（Workers 限制 30s）
};

// 输入验证配置
const VALIDATION_CONFIG = {
  MAX_INSTANCES: 100,       // 最大实例数上限
  MAX_DEPLOY_LIMIT: 100,    // 部署历史最大查询数
  MIN_LIMIT: 1,             // 最小查询数
  API_KEY_MIN_LENGTH: 12,   // API Key 最小长度
};

// ============================================================================
// Section 2: 辅助工具函数 (utils/helpers.js)
// ============================================================================

/**
 * 辅助工具函数
 */


/**
 * 生成随机ID
 * @param {number} length - ID长度（字节数）
 * @returns {string} - 十六进制随机ID
 */
function generateRandomId(length = 32) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成账户 ID
 * @returns {string} - 格式为 acc_xxxx 的账户 ID
 */
function generateAccountId() {
  return `acc_${generateRandomId(8)}`;
}

/**
 * 从 Cookie 头中读取指定 Cookie 值
 * @param {string} cookieHeader - Cookie 头字符串
 * @param {string} name - Cookie 名称
 * @returns {string|null} - Cookie 值
 */
function getCookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [cookieName, ...rest] = cookie.trim().split('=');
    if (cookieName === name) {
      return rest.join('=');
    }
  }

  return null;
}

/**
 * 转义HTML特殊字符，防止XSS攻击
 * @param {string} text - 原始文本
 * @returns {string} - 转义后的文本
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

/**
 * 生成用于 CSRF 的随机 token
 * @returns {string} - CSRF token
 */
function generateCsrfToken() {
  return generateRandomId(32);
}

/**
 * 通过ID或名称查找账户（内部使用）
 * @param {Array} accounts - 账户列表
 * @param {string} accountNameOrId - 账户ID或名称
 * @returns {Object|undefined} - 找到的账户
 */
function findAccount(accounts, accountNameOrId) {
  return accounts.find(acc =>
    acc.id === accountNameOrId ||
    acc.name.toLowerCase() === accountNameOrId.toLowerCase()
  );
}

/**
 * 获取并查找账户（内部使用）
 * @param {Object} env - 环境变量
 * @param {string} accountNameOrId - 账户ID或名称
 * @returns {Promise<Object|undefined>} - 找到的账户
 */
async function getAccountByNameOrId(env, accountNameOrId) {
  const accounts = await getAccounts(env);
  return findAccount(accounts, accountNameOrId);
}

/**
 * 在 handler 中获取账户并统一处理“找不到账户”和异常响应
 * @param {Object} env - 环境变量
 * @param {string} accountNameOrId - 账户ID或名称
 * @param {Object} options - 选项
 * @param {string} options.notFoundMessage - 账户不存在时返回的错误文案
 * @param {string} options.errorLogLabel - 捕获异常时的日志前缀
 * @param {string} options.errorResponseMessage - 捕获异常时返回给客户端的错误文案
 * @param {(account: Object) => Promise<Response>} fn - 业务处理函数
 * @returns {Promise<Response>}
 */
async function withAccount(env, accountNameOrId, options, fn) {
  const { notFoundMessage, errorLogLabel, errorResponseMessage } = options;

  const account = await getAccountByNameOrId(env, accountNameOrId);
  if (!account) {
    return jsonResponse({ error: notFoundMessage }, HTTP_STATUS.NOT_FOUND);
  }

  try {
    return await fn(account);
  } catch (error) {
    console.error(errorLogLabel, error);

    const message =
      typeof errorResponseMessage === 'string' && errorResponseMessage
        ? errorResponseMessage
        : '服务端错误';

    return jsonResponse({ error: message }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * 从 KV 读取账户列表
 * @param {Object} env - 环境变量
 * @returns {Promise<Array>} - 账户列表
 */
async function getAccounts(env) {
  try {
    const accountsData = await env.RENDER_KV.get(KV_KEYS.ACCOUNTS);
    if (!accountsData) {
      return [];
    }
    return JSON.parse(accountsData);
  } catch (error) {
    console.error('获取账户配置失败:', error);
    return [];
  }
}

/**
 * 保存账户列表到 KV
 * @param {Array} accounts - 账户列表
 * @param {Object} env - 环境变量
 */
async function saveAccounts(accounts, env) {
  try {
    await env.RENDER_KV.put(KV_KEYS.ACCOUNTS, JSON.stringify(accounts));
  } catch (error) {
    console.error('保存账户配置失败:', error);
    throw error;
  }
}

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  return ip.trim().toLowerCase();
}

function normalizeUsername(username) {
  if (!username) return 'unknown';
  return String(username).trim().toLowerCase();
}

function getClientIp(request) {
  // 优先使用 CF-Connecting-IP，因为在 Cloudflare Workers 环境中更可靠且难以伪造
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return normalizeIp(cfIp);

  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }

  return 'unknown';
}

function getCookieSecurityAttribute(request) {
  try {
    const url = new URL(request.url);
    return url.protocol === 'https:' ? '; Secure' : '';
  } catch {
    return '';
  }
}

function getLoginAttemptKey(type, value) {
  return KV_KEYS.LOGIN_ATTEMPT_PREFIX + type + ':' + value;
}

function computeLockSeconds(attempts) {
  const exponent = Math.max(0, attempts - LOGIN_RATE_LIMIT.MAX_ATTEMPTS);
  const lock = LOGIN_RATE_LIMIT.BASE_LOCK_SECONDS * Math.pow(2, exponent);
  return Math.min(lock, LOGIN_RATE_LIMIT.MAX_LOCK_SECONDS);
}

async function readLoginAttempt(env, key) {
  const raw = await env.RENDER_KV.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error('解析登录尝试记录失败:', error);
    return null;
  }
}

async function writeLoginAttempt(env, key, data) {
  await env.RENDER_KV.put(
    key,
    JSON.stringify(data),
    { expirationTtl: LOGIN_RATE_LIMIT.WINDOW_SECONDS }
  );
}

async function clearLoginAttempt(env, key) {
  await env.RENDER_KV.delete(key);
}

async function evaluateAttemptLock(attempt) {
  if (!attempt) return { locked: false, lockedUntil: 0 };
  const lockedUntil = Number(attempt.lockedUntil || 0);
  if (!lockedUntil) return { locked: false, lockedUntil: 0 };
  const now = Date.now();
  return { locked: lockedUntil > now, lockedUntil };
}

async function checkLoginLock(env, ip, username) {
  const normalizedIp = normalizeIp(ip);
  const normalizedUser = normalizeUsername(username);

  const ipKey = getLoginAttemptKey('ip', normalizedIp);
  const userKey = getLoginAttemptKey('user', normalizedUser);

  const [ipAttempt, userAttempt] = await Promise.all([
    readLoginAttempt(env, ipKey),
    readLoginAttempt(env, userKey)
  ]);

  const ipLock = await evaluateAttemptLock(ipAttempt);
  if (ipLock.locked) return { locked: true, lockedUntil: ipLock.lockedUntil };

  const userLock = await evaluateAttemptLock(userAttempt);
  if (userLock.locked) return { locked: true, lockedUntil: userLock.lockedUntil };

  return { locked: false, lockedUntil: 0 };
}

async function recordLoginFailure(env, ip, username) {
  const normalizedIp = normalizeIp(ip);
  const normalizedUser = normalizeUsername(username);

  const ipKey = getLoginAttemptKey('ip', normalizedIp);
  const userKey = getLoginAttemptKey('user', normalizedUser);

  const [ipAttempt, userAttempt] = await Promise.all([
    readLoginAttempt(env, ipKey),
    readLoginAttempt(env, userKey)
  ]);

  const now = Date.now();

  const nextIpAttempts = (ipAttempt?.attempts || 0) + 1;
  const nextUserAttempts = (userAttempt?.attempts || 0) + 1;

  const ipLockSeconds = nextIpAttempts >= LOGIN_RATE_LIMIT.MAX_ATTEMPTS
    ? computeLockSeconds(nextIpAttempts)
    : 0;
  const userLockSeconds = nextUserAttempts >= LOGIN_RATE_LIMIT.MAX_ATTEMPTS
    ? computeLockSeconds(nextUserAttempts)
    : 0;

  const nextIpState = {
    attempts: nextIpAttempts,
    lockedUntil: ipLockSeconds ? now + ipLockSeconds * 1000 : 0,
    updatedAt: now,
  };

  const nextUserState = {
    attempts: nextUserAttempts,
    lockedUntil: userLockSeconds ? now + userLockSeconds * 1000 : 0,
    updatedAt: now,
  };

  await Promise.all([
    writeLoginAttempt(env, ipKey, nextIpState),
    writeLoginAttempt(env, userKey, nextUserState)
  ]);

  return {
    ip: nextIpState,
    user: nextUserState,
  };
}

async function clearLoginFailures(env, ip, username) {
  const normalizedIp = normalizeIp(ip);
  const normalizedUser = normalizeUsername(username);

  const ipKey = getLoginAttemptKey('ip', normalizedIp);
  const userKey = getLoginAttemptKey('user', normalizedUser);

  await Promise.all([
    clearLoginAttempt(env, ipKey),
    clearLoginAttempt(env, userKey)
  ]);
}

/**
 * 时序安全的字符串比较（防止时序攻击）
 * @param {string} a - 字符串 a
 * @param {string} b - 字符串 b
 * @returns {boolean} - 是否相等
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);

  if (aBytes.length !== bBytes.length) {
    // 为了时序安全，仍需遍历完整长度
    let result = 1;
    const maxLen = Math.max(aBytes.length, bBytes.length);
    for (let i = 0; i < maxLen; i++) {
      result |= (aBytes[i % aBytes.length] || 0) ^ (bBytes[i % bBytes.length] || 0);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < aBytes.length; i++) {
    result |= aBytes[i] ^ bBytes[i];
  }
  return result === 0;
}

/**
 * 安全生成 API Key 预览（处理短 Key 边界情况）
 * @param {string} apiKey - 完整 API Key
 * @param {number} minLength - 最小长度要求
 * @returns {string} - API Key 预览
 */
function getApiKeyPreview(apiKey, minLength = 12) {
  if (!apiKey) return '';
  if (apiKey.length < minLength) {
    return '***';
  }
  return `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`;
}

/**
 * 安全解析 JSON 请求体
 * @param {Request} request - 请求对象
 * @returns {Promise<{data: Object|null, error: string|null}>}
 */
async function safeParseJson(request) {
  try {
    const data = await request.json();
    return { data, error: null };
  } catch (error) {
    return { data: null, error: '无效的 JSON 格式' };
  }
}

/**
 * 验证并限制数字范围
 * @param {any} value - 输入值
 * @param {number} defaultValue - 默认值
 * @param {number} min - 最小值
 * @param {number} max - 最大值
 * @returns {number} - 验证后的数字
 */
function clampNumber(value, defaultValue, min, max) {
  const num = parseInt(value, 10);
  if (isNaN(num)) return defaultValue;
  return Math.min(Math.max(num, min), max);
}

// ============================================================================
// Section 3: 响应工具函数 (utils/response.js)
// ============================================================================


/**
 * 获取安全响应头
 * @param {string} contentType - 内容类型
 * @returns {Object} - 响应头对象
 */
function getSecurityHeaders(contentType, options = {}) {
  const headers = {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Cache-Control': 'no-store',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };

  if (contentType.startsWith('text/html')) {
    const nonce = options.nonce;
    const styleSrc = nonce ? "'self' 'nonce-" + nonce + "'" : "'self'";
    const scriptSrc = nonce ? "'self' 'nonce-" + nonce + "'" : "'self'";

    headers['X-Frame-Options'] = 'DENY';
    headers['Content-Security-Policy'] = [
      "default-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "style-src " + styleSrc,
      "style-src-attr 'unsafe-inline'",
      "script-src " + scriptSrc,
      "script-src-attr 'none'",
      "connect-src 'self'",
      "object-src 'none'",
    ].join('; ');
  }

  return headers;
}

function generateNonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function applyHtmlNonce(html, nonce) {
  if (!nonce || !html) return html;
  return html.replace(/__CSP_NONCE__/g, nonce);
}

/**
 * 创建 JSON 响应
 * @param {Object} data - 响应数据
 * @param {number} status - HTTP 状态码
 * @returns {Response} - JSON 响应
 */
function jsonResponse(data, status = HTTP_STATUS.OK) {
  return new Response(JSON.stringify(data), {
    status,
    headers: getSecurityHeaders('application/json; charset=utf-8')
  });
}

/**
 * 创建重定向响应
 * @param {string} location - 重定向目标
 * @param {Object} additionalHeaders - 额外的响应头
 * @returns {Response} - 重定向响应
 */
function redirectResponse(location, additionalHeaders = {}) {
  const headers = new Headers(additionalHeaders);
  headers.set('Location', location);

  return new Response(null, {
    status: HTTP_STATUS.FOUND,
    headers
  });
}

/**
 * 创建 HTML 响应
 * @param {string} html - HTML 内容
 * @param {number} status - HTTP 状态码
 * @returns {Response} - HTML 响应
 */
function htmlResponse(html, status = HTTP_STATUS.OK) {
  const nonce = generateNonce();
  const safeHtml = applyHtmlNonce(html, nonce);

  return new Response(safeHtml, {
    status,
    headers: getSecurityHeaders('text/html; charset=utf-8', { nonce })
  });
}

/**
 * 创建无内容响应
 * @returns {Response} - 204 响应
 */
function noContentResponse() {
  return new Response(null, { status: HTTP_STATUS.NO_CONTENT });
}

// ============================================================================
// Section 4: 会话服务 (services/session.js)
// ============================================================================


/**
 * 创建会话
 * @param {string} username - 用户名
 * @param {Object} env - 环境变量
 * @returns {Promise<string>} - 会话ID
 */
async function createSession(username, env) {
  const sessionId = generateRandomId(32);
  const sessionData = {
    username: username,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_CONFIG.EXPIRY
  };

  const key = `${KV_KEYS.SESSION_PREFIX}${sessionId}`;
  try {
    // 设置 KV 过期时间（秒）
    const ttlSeconds = Math.floor(SESSION_CONFIG.EXPIRY / 1000);
    await env.RENDER_KV.put(key, JSON.stringify(sessionData), { expirationTtl: ttlSeconds });
  } catch (error) {
    console.error('保存会话到 KV 失败:', error);
    throw error;
  }

  return sessionId;
}

/**
 * 验证用户会话（支持滑动续期）
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} options - 选项 { sliding: boolean }
 * @returns {Promise<{session: Object|null, setCookie: string|null}>}
 */
async function verifySession(request, env, options = {}) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const sessionId = getCookieValue(cookieHeader, 'session');

  if (!sessionId) {
    return { session: null, setCookie: null };
  }

  try {
    const key = `${KV_KEYS.SESSION_PREFIX}${sessionId}`;
    const sessionData = await env.RENDER_KV.get(key);

    if (!sessionData) {
      return { session: null, setCookie: null };
    }

    const session = JSON.parse(sessionData);
    const now = Date.now();

    // 检查会话是否过期
    if (session.expiresAt < now) {
      await env.RENDER_KV.delete(key);
      return { session: null, setCookie: null };
    }

    // 滑动续期
    if (options.sliding) {
      const newExpiresAt = now + SESSION_CONFIG.EXPIRY;

      // 仅在"真正需要延长"时才刷新，减少 KV 写入频率
      const shouldRefresh =
        typeof session.expiresAt !== 'number' ||
        newExpiresAt - session.expiresAt >= SESSION_CONFIG.MIN_REFRESH_INTERVAL;

      if (shouldRefresh) {
        session.expiresAt = newExpiresAt;
        session.lastSeenAt = now;

        const ttlSeconds = Math.floor(SESSION_CONFIG.EXPIRY / 1000);
        await env.RENDER_KV.put(key, JSON.stringify(session), { expirationTtl: ttlSeconds });

        const maxAgeSeconds = Math.floor(SESSION_CONFIG.EXPIRY / 1000);
        // 动态判断 Secure 属性，与登录时保持一致
        const secureAttr = getCookieSecurityAttribute(request);
        const setCookie = `session=${sessionId}; Path=/${secureAttr}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;

        return { session, setCookie };
      }
    }

    return { session, setCookie: null };
  } catch (error) {
    console.error('会话验证错误:', error);
    return { session: null, setCookie: null };
  }
}

/**
 * 销毁会话
 * @param {string} sessionId - 会话ID
 * @param {Object} env - 环境变量
 */
async function destroySession(sessionId, env) {
  const key = `${KV_KEYS.SESSION_PREFIX}${sessionId}`;
  await env.RENDER_KV.delete(key);
}

// ============================================================================
// Section 5: 缓存服务 (services/cache.js)
// ============================================================================

/**
 * 缓存服务
 * 使用 KV 存储 Services 数据，支持软/硬 TTL
 */


/**
 * 生成账户缓存 Key（包含版本号）
 * @param {string} accountId - 账户 ID
 * @returns {string}
 */
function getCacheKey(accountId) {
  return `${KV_KEYS.SERVICES_CACHE_PREFIX}${CACHE_CONFIG.VERSION}:${accountId}`;
}

/**
 * 获取账户的 Services 缓存
 * @param {Object} env - 环境变量
 * @param {string} accountId - 账户 ID
 * @returns {Promise<{data: Array, cachedAt: number, status: 'fresh'|'stale'|'expired'}|null>}
 */
async function getServicesCache(env, accountId) {
  try {
    const key = getCacheKey(accountId);
    const cached = await env.RENDER_KV.get(key, 'json');

    if (!cached) {
      return null;
    }

    const now = Date.now();
    const age = now - cached.cachedAt;

    if (age < CACHE_CONFIG.SOFT_TTL) {
      return { ...cached, status: 'fresh' };
    } else if (age < CACHE_CONFIG.HARD_TTL) {
      return { ...cached, status: 'stale' };
    } else {
      // 硬过期：返回 null 强制重新获取
      return null;
    }
  } catch (error) {
    console.error('读取缓存出错:', error);
    return null;
  }
}

/**
 * 设置账户的 Services 缓存
 * @param {Object} env - 环境变量
 * @param {string} accountId - 账户 ID
 * @param {Array} services - Services 数据
 * @returns {Promise<void>}
 */
async function setServicesCache(env, accountId, services) {
  try {
    const key = getCacheKey(accountId);
    const data = {
      services,
      cachedAt: Date.now(),
    };

    await env.RENDER_KV.put(key, JSON.stringify(data), {
      expirationTtl: CACHE_CONFIG.KV_TTL,
    });
  } catch (error) {
    console.error('写入缓存出错:', error);
  }
}

/**
 * 删除账户的 Services 缓存
 * @param {Object} env - 环境变量
 * @param {string} accountId - 账户 ID
 * @returns {Promise<void>}
 */
async function invalidateServicesCache(env, accountId) {
  try {
    const key = getCacheKey(accountId);
    await env.RENDER_KV.delete(key);
  } catch (error) {
    console.error('删除缓存出错:', error);
  }
}

/**
 * 获取所有账户的缓存状态
 * @param {Object} env - 环境变量
 * @param {Array} accounts - 账户列表
 * @returns {Promise<{accountId: string, cache: Object|null}[]>}
 */
async function getAllServicesCaches(env, accounts) {
  const results = await Promise.all(
    accounts.map(async (account) => ({
      accountId: account.id,
      account,
      cache: await getServicesCache(env, account.id),
    }))
  );
  return results;
}

// ============================================================================
// Section 6: Render API 客户端 (services/renderApi.js)
// ============================================================================


/**
 * Render API 客户端封装
 */

/**
 * 创建 API 请求头
 * @param {string} apiKey - API 密钥
 * @returns {Object} - 请求头对象
 */
function createHeaders(apiKey) {
  return {
    'accept': 'application/json',
    'authorization': `Bearer ${apiKey}`,
    'content-type': 'application/json'
  };
}

/**
 * 延迟函数
 * @param {number} ms - 毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取重试延迟时间
 * @param {Response} response - 响应对象
 * @param {number} attempt - 当前尝试次数
 * @returns {number} - 延迟毫秒数
 */
function getRetryDelayMs(response, attempt) {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds * 1000;
    }
  }
  return 500 * attempt;
}

/**
 * 发起带重试的 API 请求
 * @param {string} url - 请求地址
 * @param {Object} options - fetch 选项
 * @param {Object} config - 配置 { timeoutMs, maxAttempts }
 * @returns {Promise<Object|null>} - 响应数据
 */
async function fetchWithRetry(url, options, { timeoutMs = API_CONFIG.TIMEOUT_MS, maxAttempts = API_CONFIG.MAX_ATTEMPTS } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });

      // 如果是 429 或 5xx 错误，尝试重试
      if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
        // 消费响应体以确保连接正确关闭
        await response.text().catch(() => {});
        await sleep(getRetryDelayMs(response, attempt));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`API 请求失败 (${response.status}): ${text || response.statusText}`);
      }

      if (response.status === 204) {
        return null;
      }

      // 处理可能为空的响应体
      const text = await response.text();
      if (!text || text.trim() === '') {
        return null;
      }

      return JSON.parse(text);
    } catch (error) {
      if (error?.name === 'AbortError' && attempt < maxAttempts) {
        await sleep(500 * attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error('请求失败: 超出重试次数');
}

/**
 * 获取特定Render账户的服务
 * @param {Object} account - 账户配置
 * @returns {Promise<Array>} - 服务列表
 */
async function getServicesForAccount(account) {
  const allItems = [];
  const seenCursors = new Set();
  let cursor = null;

  while (true) {
    const params = new URLSearchParams();
    params.set('includePreviews', 'true');
    params.set('limit', API_CONFIG.PAGE_LIMIT.toString());
    if (cursor) {
      params.set('cursor', cursor);
    }

    const url = `${RENDER_API_BASE}/services?${params.toString()}`;
    const page = await fetchWithRetry(url, {
      headers: createHeaders(account.apiKey)
    });

    if (!page) {
      break;
    }
    if (!Array.isArray(page)) {
      throw new Error('API 返回数据格式错误');
    }
    if (page.length === 0) {
      break;
    }

    allItems.push(...page);

    const nextCursor = page[page.length - 1]?.cursor;
    if (!nextCursor || typeof nextCursor !== 'string') {
      break;
    }
    if (seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  // 根据实际API响应转换服务，仅包含必要信息
  // 过滤掉无效的 item 或缺少 service 字段的数据
  return allItems
    .filter(item => item && item.service)
    .map(item => {
      const service = item.service;
      return {
        id: service.id,
        name: service.name,
        type: service.type,
        autoDeploy: service.autoDeploy,
        autoDeployTrigger: service.autoDeployTrigger,
        createdAt: service.createdAt,
        updatedAt: service.updatedAt,
        suspended: service.suspended,
        dashboardUrl: service.dashboardUrl,
        url: service.serviceDetails?.url,
        region: service.serviceDetails?.region,
        plan: service.serviceDetails?.plan,
        env: service.serviceDetails?.env,
        imagePath: service.imagePath,
        ownerId: service.ownerId
      };
    });
}

/**
 * 触发服务部署
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 要部署的服务ID
 * @returns {Promise<Object>} - 部署结果
 */
async function triggerDeployment(account, serviceId) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/deploys`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: createHeaders(account.apiKey),
    body: JSON.stringify({ clearCache: 'do_not_clear' })
  });
}

/**
 * 获取服务的事件日志
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @param {number} limit - 获取数量
 * @returns {Promise<Array>} - 事件列表
 */
async function getEventsForService(account, serviceId, limit = 5) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/events?limit=${limit}`;
  return await fetchWithRetry(url, {
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 获取服务的环境变量
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @returns {Promise<Array>} - 环境变量列表
 */
async function getEnvVarsForService(account, serviceId) {
  const allItems = [];
  const seenCursors = new Set();
  let cursor = null;

  while (true) {
    const params = new URLSearchParams();
    params.set('limit', API_CONFIG.PAGE_LIMIT.toString());
    if (cursor) {
      params.set('cursor', cursor);
    }

    const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/env-vars?${params.toString()}`;
    const page = await fetchWithRetry(url, {
      headers: createHeaders(account.apiKey)
    });

    if (!page) {
      break;
    }
    if (!Array.isArray(page)) {
      throw new Error('API 返回数据格式错误');
    }
    if (page.length === 0) {
      break;
    }

    allItems.push(...page);

    const nextCursor = page[page.length - 1]?.cursor;
    if (!nextCursor || typeof nextCursor !== 'string') {
      break;
    }
    if (seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return allItems;
}

/**
 * 更新服务的所有环境变量
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @param {Array} envVars - 环境变量列表
 * @returns {Promise<Array>} - 更新后的环境变量
 */
async function updateAllEnvVarsForService(account, serviceId, envVars) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/env-vars`;
  return await fetchWithRetry(url, {
    method: 'PUT',
    headers: createHeaders(account.apiKey),
    body: JSON.stringify(envVars)
  });
}

/**
 * 更新服务的单个环境变量
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @param {string} envVarKey - 环境变量键
 * @param {string} value - 环境变量值
 * @returns {Promise<Object>} - 更新后的环境变量
 */
async function updateSingleEnvVarForService(account, serviceId, envVarKey, value) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(envVarKey)}`;
  return await fetchWithRetry(url, {
    method: 'PUT',
    headers: createHeaders(account.apiKey),
    body: JSON.stringify({ value })
  });
}

/**
 * 删除服务的环境变量
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @param {string} envVarKey - 环境变量键
 */
async function deleteEnvVarForService(account, serviceId, envVarKey) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/env-vars/${encodeURIComponent(envVarKey)}`;
  await fetchWithRetry(url, {
    method: 'DELETE',
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 获取单个服务详情
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @returns {Promise<Object>} - 服务详情
 */
async function getServiceDetails(account, serviceId) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}`;
  return await fetchWithRetry(url, {
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 暂停服务
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @returns {Promise<Object>} - 操作结果
 */
async function suspendService(account, serviceId) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/suspend`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 恢复服务
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @returns {Promise<Object>} - 操作结果
 */
async function resumeService(account, serviceId) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/resume`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 重启服务
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @returns {Promise<Object>} - 操作结果
 */
async function restartService(account, serviceId) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/restart`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 获取服务部署列表
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @param {number} limit - 获取数量
 * @returns {Promise<Array>} - 部署列表
 */
async function getDeploysForService(account, serviceId, limit = 10) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/deploys?limit=${limit}`;
  return await fetchWithRetry(url, {
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 取消部署
 * @param {Object} account - 账户配置
 * @param {string} deployId - 部署ID
 * @returns {Promise<Object>} - 操作结果
 */
async function cancelDeploy(account, deployId) {
  const url = `${RENDER_API_BASE}/deploys/${encodeURIComponent(deployId)}/cancel`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 回滚到指定部署
 * @param {Object} account - 账户配置
 * @param {string} deployId - 部署ID
 * @returns {Promise<Object>} - 操作结果
 */
async function rollbackDeploy(account, deployId) {
  const url = `${RENDER_API_BASE}/deploys/${encodeURIComponent(deployId)}/rollback`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 获取服务实例列表
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @returns {Promise<Array>} - 实例列表
 */
async function getServiceInstances(account, serviceId) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/instances`;
  return await fetchWithRetry(url, {
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 获取服务日志
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @param {Object} options - 查询选项
 * @returns {Promise<Object>} - 日志数据
 */
async function getServiceLogs(account, serviceId, options = {}) {
  const params = new URLSearchParams();

  // 必需参数
  params.append('ownerId', account.ownerId);
  params.append('resource', serviceId);
  params.append('direction', 'backward');

  // 可选参数
  if (options.limit) params.append('limit', options.limit.toString());
  if (options.startTime) params.append('startTime', options.startTime);
  if (options.endTime) params.append('endTime', options.endTime);

  const url = `${RENDER_API_BASE}/logs?${params.toString()}`;
  return await fetchWithRetry(url, {
    headers: createHeaders(account.apiKey)
  });
}

/**
 * 扩缩容服务实例
 * @param {Object} account - 账户配置
 * @param {string} serviceId - 服务ID
 * @param {number} numInstances - 目标实例数
 * @returns {Promise<Object>} - 操作结果
 */
async function scaleServiceInstances(account, serviceId, numInstances) {
  const url = `${RENDER_API_BASE}/services/${encodeURIComponent(serviceId)}/scale`;
  return await fetchWithRetry(url, {
    method: 'POST',
    headers: createHeaders(account.apiKey),
    body: JSON.stringify({ numInstances })
  });
}

/**
 * 测试 Render API Key 有效性
 * @param {string} apiKey - API 密钥
 * @returns {Promise<Object>} - 用户信息 { ownerId, ownerEmail, ownerName, ownerType }
 */
async function testRenderApiKey(apiKey) {
  const url = `${RENDER_API_BASE}/owners?limit=1`;
  const data = await fetchWithRetry(url, {
    headers: createHeaders(apiKey)
  });

  if (!data || !Array.isArray(data) || data.length === 0) {
    throw new Error('API 返回数据格式错误');
  }

  const ownerWrapper = data[0];
  if (!ownerWrapper || typeof ownerWrapper !== 'object' || !ownerWrapper.owner) {
    throw new Error('API 返回数据格式错误: 缺少 owner 字段');
  }

  const owner = ownerWrapper.owner;
  if (!owner.id || !owner.email) {
    throw new Error('API 返回数据格式错误: owner 缺少必要字段');
  }

  return {
    ownerId: owner.id,
    ownerEmail: owner.email,
    ownerName: owner.name || owner.email,
    ownerType: owner.type || 'user'
  };
}

// ============================================================================
// Section 7: 认证处理器 (handlers/auth.js)
// ============================================================================

  getClientIp,
  getCookieValue,
  getCookieSecurityAttribute,
  checkLoginLock,
  recordLoginFailure,
  clearLoginFailures,
  timingSafeEqual,

/**
 * 处理用户登录
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleAuth(request, env) {
  try {
    const formData = await request.formData();
    const username = formData.get('username');
    const password = formData.get('password');
    const clientIp = getClientIp(request);

    const lockStatus = await checkLoginLock(env, clientIp, username);
    if (lockStatus.locked) {
      return renderLoginPage('尝试次数过多，请稍后再试');
    }

    if (timingSafeEqual(username, env.ADMIN_USERNAME) && timingSafeEqual(password, env.ADMIN_PASSWORD)) {
      const sessionId = await createSession(username, env);
      await clearLoginFailures(env, clientIp, username);

      const secureAttr = getCookieSecurityAttribute(request);
      const headers = new Headers();
      headers.set('Set-Cookie', `session=${sessionId}; Path=/${secureAttr}; HttpOnly; SameSite=Strict; Max-Age=86400`);
      headers.set('Location', '/');

      return new Response(null, { status: HTTP_STATUS.FOUND, headers });
    } else {
      await recordLoginFailure(env, clientIp, username);
      return renderLoginPage('用户名或密码无效');
    }
  } catch (error) {
    console.error('登录错误:', error);
    return renderLoginPage('登录过程中发生错误');
  }
}

/**
 * 处理用户登出
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleLogout(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const sessionId = getCookieValue(cookieHeader, 'session');

  // 尝试销毁会话，但即使失败也继续登出流程
  if (sessionId) {
    try {
      await destroySession(sessionId, env);
    } catch (error) {
      console.error('销毁会话失败:', error);
      // 继续执行登出流程
    }
  }

  const secureAttr = getCookieSecurityAttribute(request);
  const headers = new Headers();
  headers.append('Set-Cookie', `session=; Path=/${secureAttr}; HttpOnly; SameSite=Strict; Max-Age=0`);
  headers.append('Set-Cookie', `csrf_token=; Path=/${secureAttr}; SameSite=Strict; Max-Age=0`);
  headers.set('Location', '/login');

  return new Response(null, { status: HTTP_STATUS.FOUND, headers });
}

// ============================================================================
// Section 8: 账户管理处理器 (handlers/accounts.js)
// ============================================================================


/**
 * 获取账户列表
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleGetAccounts(request, env) {
  try {
    const accounts = await getAccounts(env);

    // 隐藏完整 API Key，仅返回预览
    const safeAccounts = accounts.map(acc => ({
      id: acc.id,
      name: acc.name,
      email: acc.email || '',
      ownerName: acc.ownerName || acc.name,
      apiKeyPreview: getApiKeyPreview(acc.apiKey),
      createdAt: acc.createdAt || new Date().toISOString(),
      updatedAt: acc.updatedAt,
    }));

    return jsonResponse(safeAccounts);
  } catch (error) {
    console.error('获取账户列表出错:', error);
    return jsonResponse({ error: '获取账户列表失败' }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * 添加新账户
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleAddAccount(request, env) {
  try {
    const { data, error: parseError } = await safeParseJson(request);
    if (parseError) {
      return jsonResponse({ error: parseError }, HTTP_STATUS.BAD_REQUEST);
    }

    const { name, apiKey } = data || {};

    if (!name || !name.trim()) {
      return jsonResponse({ error: '账户名称不能为空' }, HTTP_STATUS.BAD_REQUEST);
    }

    if (!apiKey || !apiKey.trim()) {
      return jsonResponse({ error: 'API Key 不能为空' }, HTTP_STATUS.BAD_REQUEST);
    }

    // 测试 API Key 并获取用户信息
    let ownerInfo;
    try {
      ownerInfo = await testRenderApiKey(apiKey.trim());
    } catch (error) {
      return jsonResponse({
        error: 'API Key 无效或无法连接到 Render API'
      }, HTTP_STATUS.BAD_REQUEST);
    }

    const accounts = await getAccounts(env);

    // 检查名称是否重复
    if (accounts.some(acc => acc.name.toLowerCase() === name.trim().toLowerCase())) {
      return jsonResponse({ error: '账户名称已存在' }, HTTP_STATUS.BAD_REQUEST);
    }

    // 检查邮箱是否已存在（防止同一账户多次添加）
    if (accounts.some(acc => acc.email === ownerInfo.ownerEmail)) {
      return jsonResponse({ error: '该 Render 账户已添加' }, HTTP_STATUS.BAD_REQUEST);
    }

    const newAccount = {
      id: generateAccountId(),
      name: name.trim(),
      apiKey: apiKey.trim(),
      email: ownerInfo.ownerEmail,
      ownerName: ownerInfo.ownerName,
      ownerId: ownerInfo.ownerId,
      ownerType: ownerInfo.ownerType,
      createdAt: new Date().toISOString(),
    };

    accounts.push(newAccount);
    await saveAccounts(accounts, env);

    return jsonResponse({
      id: newAccount.id,
      name: newAccount.name,
      email: newAccount.email,
      ownerName: newAccount.ownerName,
      apiKeyPreview: getApiKeyPreview(newAccount.apiKey),
      createdAt: newAccount.createdAt
    });
  } catch (error) {
    console.error('添加账户出错:', error);
    return jsonResponse({ error: '添加账户失败' }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * 更新账户
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleUpdateAccount(request, match, env) {
  try {
    const accountId = match[1];
    const { data, error: parseError } = await safeParseJson(request);
    if (parseError) {
      return jsonResponse({ error: parseError }, HTTP_STATUS.BAD_REQUEST);
    }

    const { name, apiKey } = data || {};

    const accounts = await getAccounts(env);
    const accountIndex = accounts.findIndex(acc => acc.id === accountId);

    if (accountIndex === -1) {
      return jsonResponse({ error: '账户不存在' }, HTTP_STATUS.NOT_FOUND);
    }

    let needsSave = false;

    // 更新名称
    if (name && name.trim()) {
      // 检查新名称是否与其他账户冲突
      const nameExists = accounts.some((acc, idx) =>
        idx !== accountIndex && acc.name.toLowerCase() === name.trim().toLowerCase()
      );

      if (nameExists) {
        return jsonResponse({ error: '账户名称已存在' }, HTTP_STATUS.BAD_REQUEST);
      }

      accounts[accountIndex].name = name.trim();
      needsSave = true;
    }

    // 更新 API Key（可选）
    if (apiKey && apiKey.trim()) {
      // 测试新的 API Key
      let ownerInfo;
      try {
        ownerInfo = await testRenderApiKey(apiKey.trim());
      } catch (error) {
        return jsonResponse({
          error: 'API Key 无效或无法连接到 Render API'
        }, HTTP_STATUS.BAD_REQUEST);
      }

      // 检查是否与其他账户的邮箱冲突
      const emailExists = accounts.some((acc, idx) =>
        idx !== accountIndex && acc.email === ownerInfo.ownerEmail
      );

      if (emailExists) {
        return jsonResponse({ error: '该 Render 账户已被其他账户使用' }, HTTP_STATUS.BAD_REQUEST);
      }

      // 更新所有相关字段
      accounts[accountIndex].apiKey = apiKey.trim();
      accounts[accountIndex].email = ownerInfo.ownerEmail;
      accounts[accountIndex].ownerName = ownerInfo.ownerName;
      accounts[accountIndex].ownerId = ownerInfo.ownerId;
      accounts[accountIndex].ownerType = ownerInfo.ownerType;
      needsSave = true;
    }

    if (!needsSave) {
      return jsonResponse({ error: '没有要更新的内容' }, HTTP_STATUS.BAD_REQUEST);
    }

    accounts[accountIndex].updatedAt = new Date().toISOString();
    await saveAccounts(accounts, env);

    const updatedAccount = accounts[accountIndex];
    return jsonResponse({
      id: updatedAccount.id,
      name: updatedAccount.name,
      email: updatedAccount.email,
      ownerName: updatedAccount.ownerName,
      apiKeyPreview: getApiKeyPreview(updatedAccount.apiKey),
      updatedAt: updatedAccount.updatedAt
    });
  } catch (error) {
    console.error('更新账户出错:', error);
    return jsonResponse({ error: '更新账户失败' }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * 删除账户
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleDeleteAccount(request, match, env) {
  try {
    const accountId = match[1];

    const accounts = await getAccounts(env);
    const filteredAccounts = accounts.filter(acc => acc.id !== accountId);

    if (filteredAccounts.length === accounts.length) {
      return jsonResponse({ error: '账户不存在' }, HTTP_STATUS.NOT_FOUND);
    }

    await saveAccounts(filteredAccounts, env);

    return new Response(null, { status: HTTP_STATUS.NO_CONTENT });
  } catch (error) {
    console.error('删除账户出错:', error);
    return jsonResponse({ error: '删除账户失败' }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * 测试 API Key 连接
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleTestAccount(request, env) {
  try {
    const { data, error: parseError } = await safeParseJson(request);
    if (parseError) {
      return jsonResponse({ error: parseError }, HTTP_STATUS.BAD_REQUEST);
    }

    const { apiKey } = data || {};

    if (!apiKey || !apiKey.trim()) {
      return jsonResponse({ error: 'API Key 不能为空' }, HTTP_STATUS.BAD_REQUEST);
    }

    try {
      const ownerInfo = await testRenderApiKey(apiKey.trim());
      return jsonResponse({
        success: true,
        message: 'API Key 有效',
        ownerName: ownerInfo.ownerName,
        ownerEmail: ownerInfo.ownerEmail,
        ownerType: ownerInfo.ownerType
      });
    } catch (error) {
      return jsonResponse({
        success: false,
        error: 'API Key 无效或无法连接到 Render API'
      }, HTTP_STATUS.BAD_REQUEST);
    }
  } catch (error) {
    console.error('测试账户连接出错:', error);
    return jsonResponse({
      error: '测试连接失败'
    }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

// ============================================================================
// Section 9: 服务管理处理器 (handlers/services.js)
// ============================================================================

  setServicesCache,
  invalidateServicesCache,
  getAllServicesCaches,

/**
 * 刷新单个账户的 Services 并更新缓存
 * @param {Object} env - 环境变量
 * @param {Object} account - 账户信息
 * @returns {Promise<Array>}
 */
async function refreshAccountServices(env, account) {
  const services = await getServicesForAccount(account);
  const servicesWithAccount = services.map(service => ({
    ...service,
    accountId: account.id,
    accountName: account.name,
  }));
  await setServicesCache(env, account.id, servicesWithAccount);
  return servicesWithAccount;
}

/**
 * 处理获取服务请求（带缓存）
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - 执行上下文
 * @returns {Promise<Response>}
 */
async function handleGetServices(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get('refresh') === 'true';

    const accounts = await getAccounts(env);

    if (accounts.length === 0) {
      return jsonResponse({
        services: [],
        cachedAt: null,
      });
    }

    // 获取所有账户的缓存状态
    const cacheResults = await getAllServicesCaches(env, accounts);

    let allServices = [];
    const refreshPromises = [];
    const cacheTimes = [];

    // 收集需要同步刷新的账户
    const needsSyncRefresh = [];

    for (const { accountId, account, cache } of cacheResults) {
      if (forceRefresh || !cache) {
        // 强制刷新或无缓存：需要同步刷新
        needsSyncRefresh.push({ accountId, account });
      } else if (cache.status === 'stale') {
        // 软过期：返回缓存，后台刷新
        allServices.push(...cache.services);
        cacheTimes.push(cache.cachedAt);
        refreshPromises.push(refreshAccountServices(env, account));
      } else {
        // 缓存新鲜：直接使用
        allServices.push(...cache.services);
        cacheTimes.push(cache.cachedAt);
      }
    }

    // 并行刷新需要同步获取的账户
    if (needsSyncRefresh.length > 0) {
      const refreshResults = await Promise.allSettled(
        needsSyncRefresh.map(({ account }) => refreshAccountServices(env, account))
      );

      refreshResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          allServices.push(...result.value);
          cacheTimes.push(Date.now());
        } else {
          console.error(`刷新账户 ${needsSyncRefresh[index].account.name} 失败:`, result.reason);
        }
      });
    }

    // 后台刷新（不阻塞响应）- 使用 Promise.allSettled 避免部分失败影响
    if (refreshPromises.length > 0 && ctx && ctx.waitUntil) {
      ctx.waitUntil(
        Promise.allSettled(refreshPromises).then(results => {
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              console.error('后台刷新失败:', result.reason);
            }
          });
        })
      );
    }

    // 计算最旧的缓存时间
    let oldestCacheTime = Date.now();
    if (cacheTimes.length > 0) {
      oldestCacheTime = Math.min(...cacheTimes);
    }

    // 保证返回顺序稳定，避免 UI 每次刷新顺序随机变化
    allServices.sort((a, b) => {
      const accountA = (a.accountName || '').toLowerCase();
      const accountB = (b.accountName || '').toLowerCase();
      if (accountA !== accountB) return accountA < accountB ? -1 : 1;

      const nameA = (a.name || '').toLowerCase();
      const nameB = (b.name || '').toLowerCase();
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;

      const idA = a.id || '';
      const idB = b.id || '';
      if (idA !== idB) return idA < idB ? -1 : 1;

      return 0;
    });

    return jsonResponse({
      services: allServices,
      cachedAt: oldestCacheTime,
    });
  } catch (error) {
    console.error('获取服务出错:', error);
    return jsonResponse({ error: '获取服务失败' }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}

/**
 * 处理部署请求
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleDeploy(request, env) {
  try {
    const { data, error: parseError } = await safeParseJson(request);
    if (parseError) {
      return jsonResponse({ error: parseError }, HTTP_STATUS.BAD_REQUEST);
    }

    const { accountId, serviceId } = data || {};

    if (!accountId || !serviceId) {
      return jsonResponse({ error: '缺少必需参数: accountId 和 serviceId' }, HTTP_STATUS.BAD_REQUEST);
    }

    return withAccount(
      env,
      accountId,
      { notFoundMessage: '找不到账户', errorLogLabel: '触发部署出错:', errorResponseMessage: '触发部署失败' },
      async (account) => {
        const deployResult = await triggerDeployment(account, serviceId);
        // 部署后失效对应账户的缓存
        await invalidateServicesCache(env, account.id);
        return jsonResponse(deployResult);
      }
    );
  } catch (error) {
    console.error('触发部署出错:', error);
    return jsonResponse({ error: '触发部署失败' }, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}


// ============================================================================
// Section 10: 服务控制处理器 (handlers/serviceControl.js)
// ============================================================================

  getServiceDetails,
  suspendService,
  resumeService,
  restartService,
  getDeploysForService,
  cancelDeploy,
  rollbackDeploy

/**
 * 创建服务控制 handler 工厂函数
 * @param {Function} apiFn - API 函数
 * @param {string} errorLogLabel - 错误日志标签
 * @param {string} successMessage - 成功消息
 * @param {boolean} invalidateCache - 是否失效缓存
 * @returns {Function} - handler 函数
 */
function createServiceControlHandler(apiFn, errorLogLabel, successMessage, invalidateCache = true) {
  return async (request, match, env) => {
    const [, accountId, serviceId] = match;

    return withAccount(
      env,
      accountId,
      { notFoundMessage: '账户不存在', errorLogLabel, errorResponseMessage: null },
      async (account) => {
        const result = await apiFn(account, serviceId);
        if (invalidateCache) {
          await invalidateServicesCache(env, account.id);
        }
        return jsonResponse({ success: true, message: successMessage, data: result });
      }
    );
  };
}

/**
 * 创建部署控制 handler 工厂函数（使用 deployId 而非 serviceId）
 * @param {Function} apiFn - API 函数
 * @param {string} errorLogLabel - 错误日志标签
 * @param {string} successMessage - 成功消息
 * @returns {Function} - handler 函数
 */
function createDeployControlHandler(apiFn, errorLogLabel, successMessage) {
  return async (request, match, env) => {
    const [, accountId, deployId] = match;

    return withAccount(
      env,
      accountId,
      { notFoundMessage: '账户不存在', errorLogLabel, errorResponseMessage: null },
      async (account) => {
        const result = await apiFn(account, deployId);
        await invalidateServicesCache(env, account.id);
        return jsonResponse({ success: true, message: successMessage, data: result });
      }
    );
  };
}

/**
 * 处理获取服务详情
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleGetServiceDetails(request, match, env) {
  const [, accountId, serviceId] = match;

  return withAccount(
    env,
    accountId,
    { notFoundMessage: '账户不存在', errorLogLabel: '获取服务详情失败:', errorResponseMessage: null },
    async (account) => {
      const service = await getServiceDetails(account, serviceId);
      return jsonResponse(service);
    }
  );
}

/**
 * 处理暂停服务
 */
const handleSuspendService = createServiceControlHandler(
  suspendService,
  '暂停服务失败:',
  '服务已暂停'
);

/**
 * 处理恢复服务
 */
const handleResumeService = createServiceControlHandler(
  resumeService,
  '恢复服务失败:',
  '服务已恢复'
);

/**
 * 处理重启服务
 */
const handleRestartService = createServiceControlHandler(
  restartService,
  '重启服务失败:',
  '服务已重启'
);

/**
 * 处理获取部署列表
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleGetDeploys(request, match, env) {
  const [, accountId, serviceId] = match;

  return withAccount(
    env,
    accountId,
    { notFoundMessage: '账户不存在', errorLogLabel: '获取部署列表失败:', errorResponseMessage: null },
    async (account) => {
      const url = new URL(request.url);
      const limit = clampNumber(url.searchParams.get('limit'), 10, VALIDATION_CONFIG.MIN_LIMIT, VALIDATION_CONFIG.MAX_DEPLOY_LIMIT);
      const deploys = await getDeploysForService(account, serviceId, limit);
      return jsonResponse(deploys);
    }
  );
}

/**
 * 处理取消部署
 */
const handleCancelDeploy = createDeployControlHandler(
  cancelDeploy,
  '取消部署失败:',
  '部署已取消'
);

/**
 * 处理回滚部署
 */
const handleRollbackDeploy = createDeployControlHandler(
  rollbackDeploy,
  '回滚部署失败:',
  '已回滚到此部署'
);

// ============================================================================
// Section 11: 环境变量处理器 (handlers/envVars.js)
// ============================================================================

  getEnvVarsForService,
  updateAllEnvVarsForService,
  updateSingleEnvVarForService,
  deleteEnvVarForService

/**
 * 处理获取环境变量请求
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果 [fullPath, accountId, serviceId]
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleGetEnvVars(request, match, env) {
  const accountNameOrId = match[1];
  const serviceId = match[2];

  return withAccount(
    env,
    accountNameOrId,
    { notFoundMessage: '找不到账户', errorLogLabel: '获取环境变量出错:', errorResponseMessage: '获取环境变量失败' },
    async (account) => {
      const envVars = await getEnvVarsForService(account, serviceId);
      return jsonResponse(envVars);
    }
  );
}

/**
 * 处理更新所有环境变量请求
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果 [fullPath, accountId, serviceId]
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleUpdateAllEnvVars(request, match, env) {
  const accountNameOrId = match[1];
  const serviceId = match[2];

  return withAccount(
    env,
    accountNameOrId,
    { notFoundMessage: '找不到账户', errorLogLabel: '更新环境变量出错:', errorResponseMessage: '更新环境变量失败' },
    async (account) => {
      const { data: envVars, error: parseError } = await safeParseJson(request);
      if (parseError) {
        return jsonResponse({ error: parseError }, HTTP_STATUS.BAD_REQUEST);
      }
      if (!Array.isArray(envVars)) {
        return jsonResponse({ error: '环境变量必须是数组格式' }, HTTP_STATUS.BAD_REQUEST);
      }
      const result = await updateAllEnvVarsForService(account, serviceId, envVars);
      return jsonResponse(result);
    }
  );
}

/**
 * 处理更新单个环境变量请求
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果 [fullPath, accountId, serviceId, envVarKey]
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleUpdateSingleEnvVar(request, match, env) {
  const accountNameOrId = match[1];
  const serviceId = match[2];
  const envVarKey = match[3];

  return withAccount(
    env,
    accountNameOrId,
    { notFoundMessage: '找不到账户', errorLogLabel: '更新环境变量出错:', errorResponseMessage: '更新环境变量失败' },
    async (account) => {
      const { data, error: parseError } = await safeParseJson(request);
      if (parseError) {
        return jsonResponse({ error: parseError }, HTTP_STATUS.BAD_REQUEST);
      }
      const { value } = data || {};
      if (value === undefined) {
        return jsonResponse({ error: '缺少必需参数: value' }, HTTP_STATUS.BAD_REQUEST);
      }
      const result = await updateSingleEnvVarForService(account, serviceId, envVarKey, value);
      return jsonResponse(result);
    }
  );
}

/**
 * 处理删除环境变量请求
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果 [fullPath, accountId, serviceId, envVarKey]
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleDeleteEnvVar(request, match, env) {
  const accountNameOrId = match[1];
  const serviceId = match[2];
  const envVarKey = match[3];

  return withAccount(
    env,
    accountNameOrId,
    { notFoundMessage: '找不到账户', errorLogLabel: '删除环境变量出错:', errorResponseMessage: '删除环境变量失败' },
    async (account) => {
      await deleteEnvVarForService(account, serviceId, envVarKey);
      return noContentResponse();
    }
  );
}

// ============================================================================
// Section 12: 事件日志处理器 (handlers/events.js)
// ============================================================================


/**
 * 处理获取事件日志请求
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果 [fullPath, accountId, serviceId]
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleGetEvents(request, match, env) {
  const accountNameOrId = match[1];
  const serviceId = match[2];

  return withAccount(
    env,
    accountNameOrId,
    { notFoundMessage: '找不到账户', errorLogLabel: '获取事件日志出错:', errorResponseMessage: '获取事件日志失败' },
    async (account) => {
      const events = await getEventsForService(account, serviceId);
      return jsonResponse(events);
    }
  );
}

// ============================================================================
// Section 13: 监控处理器 (handlers/monitoring.js)
// ============================================================================

  getServiceInstances,
  getServiceLogs,
  scaleServiceInstances

/**
 * 处理获取服务实例列表
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleGetInstances(request, match, env) {
  const [, accountId, serviceId] = match;

  return withAccount(
    env,
    accountId,
    { notFoundMessage: '账户不存在', errorLogLabel: '获取实例列表失败:', errorResponseMessage: null },
    async (account) => {
      const instances = await getServiceInstances(account, serviceId);
      return jsonResponse(instances);
    }
  );
}

/**
 * 处理获取服务日志
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleGetLogs(request, match, env) {
  const [, accountId, serviceId] = match;

  return withAccount(
    env,
    accountId,
    { notFoundMessage: '账户不存在', errorLogLabel: '获取日志失败:', errorResponseMessage: null },
    async (account) => {
      const url = new URL(request.url);
      const levelFilter = url.searchParams.get('level') || undefined;
      const options = {
        startTime: url.searchParams.get('startTime') || undefined,
        endTime: url.searchParams.get('endTime') || undefined,
        limit: clampNumber(url.searchParams.get('limit'), 20, VALIDATION_CONFIG.MIN_LIMIT, VALIDATION_CONFIG.MAX_DEPLOY_LIMIT)
      };

      const data = await getServiceLogs(account, serviceId, options);
      let logs = data.logs || [];

      // Render API 返回的日志 level 在 labels 数组中，需要提取并过滤
      if (levelFilter) {
        logs = logs.filter(log => {
          const levelLabel = log.labels?.find(l => l.name === 'level');
          const logLevel = (levelLabel?.value || '').toLowerCase();
          return logLevel === levelFilter.toLowerCase();
        });
      }

      // 转换日志格式以便前端使用
      const formattedLogs = logs.map(log => {
        const levelLabel = log.labels?.find(l => l.name === 'level');
        const level = levelLabel?.value || 'info';

        // message 可能是对象或字符串
        let message;
        if (typeof log.message === 'object') {
          message = log.message.message || JSON.stringify(log.message);
        } else {
          message = log.message || '';
        }

        return {
          id: log.id,
          timestamp: log.timestamp,
          level: level,
          message: message
        };
      });

      return jsonResponse({
        logs: formattedLogs,
        hasMore: data.hasMore,
        nextStartTime: data.nextStartTime,
        nextEndTime: data.nextEndTime
      });
    }
  );
}

/**
 * 处理扩缩容服务
 * @param {Request} request - 请求对象
 * @param {Array} match - 路由匹配结果
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>} - 响应
 */
async function handleScaleService(request, match, env) {
  const [, accountId, serviceId] = match;

  return withAccount(
    env,
    accountId,
    { notFoundMessage: '账户不存在', errorLogLabel: '扩缩容服务失败:', errorResponseMessage: null },
    async (account) => {
      const { data, error: parseError } = await safeParseJson(request);
      if (parseError) {
        return jsonResponse({ error: parseError }, HTTP_STATUS.BAD_REQUEST);
      }

      const numInstances = parseInt(data?.numInstances, 10);

      if (isNaN(numInstances) || numInstances < 0) {
        return jsonResponse({ error: '无效的实例数量' }, HTTP_STATUS.BAD_REQUEST);
      }

      if (numInstances > VALIDATION_CONFIG.MAX_INSTANCES) {
        return jsonResponse({ error: `实例数量不能超过 ${VALIDATION_CONFIG.MAX_INSTANCES}` }, HTTP_STATUS.BAD_REQUEST);
      }

      const result = await scaleServiceInstances(account, serviceId, numInstances);
      // 扩缩容后失效缓存
      await invalidateServicesCache(env, account.id);
      return jsonResponse({ success: true, message: `服务已扩缩容至 ${numInstances} 个实例`, data: result });
    }
  );
}

// ============================================================================
// Section 14: 定时任务处理器 (handlers/cron.js)
// ============================================================================

/**
 * 定时任务处理器 - 服务保活 Ping
 */


/**
 * 固定延迟
 * @param {number} ms - 毫秒数
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 单个服务 Ping (带指数退避重试)
 * @param {string} url - 服务 URL
 * @param {number} retries - 剩余重试次数
 * @returns {Promise<Object>} - Ping 结果
 */
async function pingService(url, retries = PING_CONFIG.MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PING_CONFIG.TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'RenderManager-KeepAlive/1.0' }
    });
    return { url, status: response.status, success: true };
  } catch (error) {
    if (retries > 0) {
      // 指数退避：基础延迟 * 2^(已重试次数)
      const retryDelay = PING_CONFIG.RETRY_DELAY_MS * Math.pow(2, PING_CONFIG.MAX_RETRIES - retries);
      await delay(retryDelay);
      return pingService(url, retries - 1);
    }
    return { url, error: error.message, success: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 分批并发 Ping 所有服务
 * @param {Array} services - 服务列表 [{id, name, url}]
 * @returns {Promise<Array>} - Ping 结果列表
 */
async function pingAllServicesInBatches(services) {
  const results = [];
  const batchSize = PING_CONFIG.BATCH_SIZE;

  for (let i = 0; i < services.length; i += batchSize) {
    const batch = services.slice(i, i + batchSize);

    // 批内并发执行
    const batchResults = await Promise.allSettled(
      batch.map(s => pingService(s.url))
    );

    // 收集结果
    batchResults.forEach((result, idx) => {
      const service = batch[idx];
      if (result.status === 'fulfilled') {
        results.push({ id: service.id, name: service.name, ...result.value });
      } else {
        results.push({
          id: service.id,
          name: service.name,
          url: service.url,
          success: false,
          error: result.reason?.message
        });
      }
    });

    // 批次间固定短间隔（仅在还有更多批次时）
    if (i + batchSize < services.length) {
      await delay(PING_CONFIG.BATCH_INTERVAL_MS);
    }
  }

  return results;
}

/**
 * 获取账户服务（优先使用缓存）
 * @param {Object} env - 环境变量
 * @param {Object} account - 账户信息
 * @returns {Promise<Array>} - 服务列表
 */
async function getServicesWithCache(env, account) {
  // 尝试从缓存获取
  const cached = await getServicesCache(env, account.id);

  if (cached && cached.services) {
    // 缓存有效（fresh 或 stale 都可用）
    return cached.services;
  }

  // 无缓存或过期，从 API 获取并更新缓存
  const services = await getServicesForAccount(account);
  const servicesWithAccount = services.map(service => ({
    ...service,
    accountId: account.id,
    accountName: account.name,
  }));

  await setServicesCache(env, account.id, servicesWithAccount);
  return servicesWithAccount;
}

/**
 * 定时任务主处理函数
 * @param {Object} env - 环境变量
 * @param {AbortSignal} signal - 可选的中止信号
 */
async function handleScheduled(env, signal) {
  const startTime = Date.now();

  // 检查是否已超时
  const checkTimeout = () => {
    if (signal?.aborted) {
      throw new Error('Cron 任务已超时');
    }
    if (Date.now() - startTime > CRON_CONFIG.TIMEOUT_MS) {
      throw new Error('Cron 任务执行超时');
    }
  };

  try {
    // 1. 获取所有账户
    const accounts = await getAccounts(env);
    if (accounts.length === 0) {
      console.log('[Cron] 无账户配置，跳过');
      return;
    }

    checkTimeout();

    // 2. 并行获取所有账户的服务（利用缓存）
    const serviceResults = await Promise.allSettled(
      accounts.map(account => getServicesWithCache(env, account))
    );

    const allServices = [];
    serviceResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allServices.push(...result.value);
      } else {
        console.error(`[Cron] 获取账户 ${accounts[index].name} 服务失败:`, result.reason?.message);
      }
    });

    checkTimeout();

    // 3. 过滤出有 url 且未暂停的服务
    const pingTargets = allServices.filter(s => s.url && s.suspended !== 'suspended');

    if (pingTargets.length === 0) {
      console.log('[Cron] 无可 Ping 服务');
      return;
    }

    // 4. 分批并发 Ping
    const results = await pingAllServicesInBatches(pingTargets);

    // 5. 统计结果
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;
    const duration = Date.now() - startTime;

    console.log(`[Cron] Ping 完成: ${successCount}/${results.length} 成功, ${failCount} 失败, 耗时 ${duration}ms`);

    // 记录失败详情
    results.filter(r => !r.success).forEach(r => {
      console.warn(`[Cron] Ping 失败: ${r.name} (${r.url}) - ${r.error}`);
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[Cron] 任务异常终止 (${duration}ms):`, error.message);
  }
}

// ============================================================================
// Section 15: 页面处理器 (handlers/pages.js)
// ============================================================================


/**
 * 处理主页请求
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @param {boolean} isLoginPage - 是否强制显示登录页
 * @returns {Promise<Response>}
 */
async function handleMainPage(request, env, isLoginPage = false) {
  if (isLoginPage) {
    return renderLoginPage();
  }

  // 检查用户是否已登录
  const { session } = await verifySession(request, env);
  if (!session) {
    return renderLoginPage();
  }

  // 渲染仪表盘
  return renderDashboard();
}

/**
 * 处理账户管理页面请求
 * @param {Request} request - 请求对象
 * @param {Object} env - 环境变量
 * @returns {Promise<Response>}
 */
async function handleAccountsPage(request, env) {
  // 渲染账户管理页面
  return renderAccountsPage();
}

// ============================================================================
// Section 16: 样式定义 (views/styles.js)
// ============================================================================

/**
 * 登录页面样式
 */
const loginStyles = `
:root {
  /* 背景色 - 温暖纸质色调 */
  --bg-paper: #FCFAF8;
  --bg-surface: #FDFDFC;
  --bg-secondary: #F4F1EB;
  --bg-warm: #F5F2EB;

  /* 文字色 - 柔和对比 */
  --text-primary: #2D2D2D;
  --text-secondary: #6B6B6B;
  --text-muted: #9A9A9A;

  /* 强调色 */
  --accent-terracotta: #D97757;
  --accent-dark: #3D3D3D;
  --accent-success: #5C8A5C;
  --accent-warning: #C4915C;
  --accent-danger: #C45C5C;

  /* 边框色 */
  --border-light: #E8E4DE;
  --border-medium: #D4CFC6;

  /* 字体 */
  --font-serif: "Merriweather", "Georgia", "Times New Roman", serif;
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", Monaco, "Consolas", monospace;

  /* 圆角 */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;

  /* 阴影 - 柔和 */
  --shadow-sm: 0 1px 3px rgba(45, 45, 45, 0.04);
  --shadow-md: 0 4px 12px rgba(45, 45, 45, 0.06);
  --shadow-lg: 0 8px 24px rgba(45, 45, 45, 0.08);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-warm);
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
  color: var(--text-primary);
  line-height: 1.6;
}

.login-container {
  background: var(--bg-surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 48px;
  width: 100%;
  max-width: 420px;
  transition: all 0.3s ease;
}

.login-container:hover {
  transform: translateY(-3px);
  box-shadow: 0 12px 32px rgba(45, 45, 45, 0.1);
}

.logo {
  text-align: center;
  margin-bottom: 36px;
}

.logo-icon {
  width: 56px;
  height: 56px;
  background: var(--accent-dark);
  border-radius: var(--radius-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.logo-icon svg {
  width: 28px;
  height: 28px;
  fill: white;
}

h1 {
  font-family: var(--font-serif);
  font-size: 26px;
  font-weight: 600;
  color: var(--text-primary);
  text-align: center;
  margin-bottom: 8px;
  letter-spacing: -0.02em;
}

.subtitle {
  text-align: center;
  color: var(--text-secondary);
  margin-bottom: 32px;
  font-size: 15px;
  line-height: 1.6;
}

.form-group {
  margin-bottom: 24px;
}

label {
  display: block;
  margin-bottom: 8px;
  font-weight: 500;
  color: var(--text-primary);
  font-size: 14px;
}

input {
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  font-size: 15px;
  font-weight: 400;
  transition: all 0.2s ease;
  background-color: var(--bg-surface);
  color: var(--text-primary);
}

input:focus {
  outline: none;
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

input::placeholder {
  color: var(--text-muted);
}

button {
  width: 100%;
  padding: 14px 20px;
  background: var(--accent-dark);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-top: 8px;
}

button:hover {
  background: var(--text-primary);
  transform: translateY(-1px);
}

button:active {
  transform: translateY(0);
}

.error-message {
  color: var(--accent-danger);
  background-color: #FDF5F5;
  border: 1px solid var(--accent-danger);
  padding: 12px 16px;
  border-radius: var(--radius-md);
  margin-bottom: 20px;
  text-align: center;
  font-size: 14px;
  font-weight: 500;
}

.footer {
  text-align: center;
  margin-top: 32px;
  color: var(--text-secondary);
  font-size: 13px;
}

.footer a {
  color: var(--accent-terracotta);
  text-decoration: none;
  font-weight: 500;
}

.footer a:hover {
  text-decoration: underline;
}
`;

/**
 * 仪表盘页面样式
 */
const dashboardStyles = `
:root {
  /* 背景色 - 温暖纸质色调 */
  --bg-paper: #FCFAF8;
  --bg-surface: #FDFDFC;
  --bg-secondary: #F4F1EB;
  --bg-warm: #F5F2EB;

  /* 文字色 - 柔和对比 */
  --text-primary: #2D2D2D;
  --text-secondary: #6B6B6B;
  --text-muted: #9A9A9A;

  /* 强调色 */
  --accent-terracotta: #D97757;
  --accent-dark: #3D3D3D;
  --accent-success: #5C8A5C;
  --accent-warning: #C4915C;
  --accent-danger: #C45C5C;

  /* 边框色 */
  --border-light: #E8E4DE;
  --border-medium: #D4CFC6;

  /* 字体 */
  --font-serif: "Merriweather", "Georgia", "Times New Roman", serif;
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "SF Mono", Monaco, "Consolas", monospace;

  /* 圆角 */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;

  /* 阴影 - 柔和 */
  --shadow-sm: 0 1px 3px rgba(45, 45, 45, 0.04);
  --shadow-md: 0 4px 12px rgba(45, 45, 45, 0.06);
  --shadow-lg: 0 8px 24px rgba(45, 45, 45, 0.08);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* 账户管理页面专属样式 */
.account-card .service-card-header {
  padding: 1.25rem 1.5rem 1rem;
}

.account-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--accent-success);
  color: white;
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.account-owner-badge {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: var(--bg-paper);
  color: var(--text-primary);
  padding: 0.75rem 1rem;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 1.25rem;
  border: 1px solid var(--border-light);
}

.account-owner-badge svg {
  opacity: 0.9;
}

.account-info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
}

.account-info-item {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.account-info-item.full-width {
  grid-column: 1 / -1;
}

.account-info-label {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.account-info-value {
  font-size: 13px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-weight: 500;
}

.account-info-value.id-value {
  color: var(--accent-terracotta);
  background: #FDF5F3;
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-block;
  font-size: 12px;
}

.api-key-preview {
  background: #FDF8F3;
  color: var(--accent-warning);
  padding: 4px 8px;
  border-radius: 4px;
  display: inline-block;
  font-size: 12px;
}

.action-btn.danger {
  background: var(--accent-danger);
  color: white;
  border: none;
}

.action-btn.danger:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(196, 92, 92, 0.25);
}

/* 账户卡片按钮布局 - 只有编辑和删除两个按钮 */
.account-card .service-actions {
  grid-template-columns: repeat(2, 1fr);
}

/* 账户卡片编辑按钮样式 */
.account-card .action-btn.secondary {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
}

.account-card .action-btn.secondary:hover:not(:disabled) {
  background: var(--border-light);
  color: var(--text-primary);
  border-color: var(--border-medium);
}

/* 模态框表单样式 */
.form-group {
  margin-bottom: 1.5rem;
}

.form-label {
  display: block;
  font-weight: 500;
  color: var(--text-primary);
  font-size: 14px;
  margin-bottom: 0.5rem;
}

.form-input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-md);
  font-size: 14px;
  transition: all 0.2s ease;
  box-sizing: border-box;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.form-input:focus {
  outline: none;
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

.form-input.api-key-input {
  font-family: var(--font-mono);
}

.form-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 0.5rem;
}

.form-actions {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  margin-top: 2rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-light);
}

.test-btn-row {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}

.test-btn-row .form-input {
  flex: 1;
}

#testResult {
  margin-top: 1rem;
}

.test-success, .test-error, .test-loading {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem;
  border-radius: var(--radius-md);
}

.test-success {
  background: #F5FAF5;
  border: 1px solid var(--accent-success);
}

.test-error {
  background: #FDF5F5;
  border: 1px solid var(--accent-danger);
  color: var(--accent-danger);
}

.test-loading {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.test-info {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.test-title {
  font-weight: 600;
  color: var(--accent-success);
}

.test-detail {
  font-size: 13px;
  color: var(--text-primary);
}

/* 移动端响应式 */
@media (max-width: 768px) {
  .account-card .service-card-header {
    padding: 1rem;
  }

  .account-owner-badge {
    padding: 0.625rem 0.875rem;
    font-size: 13px;
    border-radius: var(--radius-md);
    margin-bottom: 1rem;
  }

  .account-info-grid {
    grid-template-columns: 1fr;
    gap: 0.75rem;
    padding: 0.875rem;
    margin-bottom: 1rem;
  }

  .account-info-label {
    font-size: 10px;
  }

  .account-info-value {
    font-size: 12px;
  }

  .account-info-value.id-value {
    font-size: 11px;
    padding: 3px 6px;
  }

  .form-group {
    margin-bottom: 1.25rem;
  }

  .form-label {
    font-size: 13px;
  }

  .form-input {
    padding: 10px 14px;
    font-size: 14px;
  }

  .form-hint {
    font-size: 11px;
  }

  .form-actions {
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-actions .action-btn {
    width: 100%;
    justify-content: center;
  }

  .test-btn-row {
    flex-direction: column;
  }

  .test-success, .test-error, .test-loading {
    padding: 0.875rem;
    font-size: 13px;
  }
}

body {
  font-family: var(--font-sans);
  background: var(--bg-paper);
  color: var(--text-primary);
  line-height: 1.7;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* 头部样式 */
.header {
  background: rgba(252, 250, 248, 0.85);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  color: var(--text-primary);
  height: 60px;
  border-bottom: 1px solid var(--border-light);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-container {
  max-width: 1400px;
  height: 100%;
  margin: 0 auto;
  padding: 0 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 12px;
  text-decoration: none;
  color: inherit;
}

.logo:hover {
  text-decoration: none;
}

.logo-icon {
  width: 36px;
  height: 36px;
  background: var(--accent-dark);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.logo-icon svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
  stroke: currentColor;
}

h1 {
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* 头部按钮统一样式 */
.header-link,
.logout-btn {
  height: 34px;
  padding: 0 14px;
  background: var(--bg-paper);
  color: var(--text-primary);
  border: var(--bg-paper);
  border-radius: var(--radius-sm);
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-sizing: border-box;
  line-height: 1;
}

.header-link:hover,
.logout-btn:hover {
  background: var(--bg-secondary);
  border-color: var(--border-medium);
}

.logout-form {
  display: flex;
  margin: 0;
}

/* 主容器 */
.main-content {
  flex: 1;
}

.container {
  max-width: 1320px;
  margin: 0 auto;
  padding: 2.5rem 2rem;
}

/* 空状态样式 */
.empty-state {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--text-secondary);
}

.empty-state-icon {
  width: 72px;
  height: 72px;
  margin-bottom: 1.5rem;
  opacity: 0.6;
}

.empty-state h3 {
  font-family: var(--font-serif);
  font-size: 18px;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
}

.empty-state p {
  font-size: 14px;
  line-height: 1.6;
}


/* 通知样式 */
.notification {
  position: fixed;
  top: 20px;
  right: 20px;
  background: var(--bg-surface);
  padding: 1rem 1.5rem;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--border-light);
  z-index: 1001;
  animation: slideInRight 0.3s ease-out;
}

.notification.success {
  border-left: 3px solid var(--accent-success);
}

.notification.error {
  border-left: 3px solid var(--accent-danger);
}

.notification-content {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.notification-icon {
  width: 20px;
  height: 20px;
}

.notification-text {
  font-size: 14px;
  color: var(--text-primary);
}

@keyframes slideInRight {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

/* 添加账户按钮 */
.add-account-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--accent-terracotta);
  color: white;
  padding: 10px 20px;
  border-radius: var(--radius-sm);
  font-weight: 500;
  font-size: 14px;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
}

.add-account-btn:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* 统计栏 */
.stats-bar {
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  padding: 1.5rem 2rem;
  margin-bottom: 2rem;
  border: 1px solid var(--border-light);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  flex-wrap: wrap;
}

.stats-content {
  display: flex;
  align-items: center;
  gap: 3rem;
  flex: 1;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.stat-icon {
  width: 44px;
  height: 44px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-terracotta);
}

.stat-info h3 {
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.stat-info p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

.filters {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  min-width: 0;
}

.cache-info-wrapper {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.cache-info {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.refresh-services-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  cursor: pointer;
  transition: all 0.2s ease;
  color: var(--text-secondary);
}

.refresh-services-btn:hover {
  background: var(--bg-secondary);
  border-color: var(--accent-dark);
  color: var(--accent-dark);
}

.refresh-services-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-services-btn.spinning svg {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.filters .search-box {
  width: 220px;
  max-width: 100%;
  min-width: 0;
}

.filter-box {
  width: 160px;
  max-width: 100%;
  min-width: 0;
}

.account-filter-select {
  width: 100%;
  padding: 10px 36px 10px 14px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  font-size: 14px;
  transition: all 0.2s ease;
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236B6B6B' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}

.account-filter-select:focus {
  outline: none;
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

.search-box {
  position: relative;
  width: 220px;
  max-width: 100%;
  min-width: 0;
}

.search-input {
  width: 100%;
  padding: 10px 36px 10px 14px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  font-size: 14px;
  transition: all 0.2s ease;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

.search-icon {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

/* 添加环境变量部分 */
.add-env-var-section {
  margin-top: 1.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--border-light);
}

.add-env-var-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.add-env-var-header h3 {
  font-family: var(--font-serif);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

/* 添加环境变量表单 */
.add-env-var-form {
  display: none;
}

.add-env-var-form.show {
  display: block !important;
}

.add-env-var-inputs {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}

.add-env-var-field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  flex: 0 0 200px;
}

.add-env-var-field-value {
  flex: 1;
}

.add-env-var-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.add-env-var-input {
  padding: 10px 12px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-family: var(--font-mono);
  transition: all 0.2s ease;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.add-env-var-input:focus {
  outline: none;
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

.add-env-var-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

/* 添加环境变量按钮 */
.add-env-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 8px 14px;
  background: var(--accent-dark);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.add-env-btn:hover {
  opacity: 0.9;
}

.add-env-btn:active {
  transform: translateY(0);
}

/* 表单按钮 */
.form-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.form-btn.primary {
  background: var(--accent-dark);
  color: white;
}

.form-btn.primary:hover {
  opacity: 0.9;
}

.form-btn.secondary {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.form-btn.secondary:hover {
  background: var(--border-light);
  color: var(--text-primary);
}

/* 服务网格 */
.services-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}

.service-card {
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  transition: all 0.2s ease;
  border: 1px solid var(--border-light);
  overflow: hidden;
}

.service-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--border-medium);
}

/* 服务卡片头部 */
.service-card-header {
  padding: 1.25rem 1.5rem;
  background: var(--bg-paper);
  border-bottom: 1px solid var(--border-light);
}

.service-header-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.service-name {
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  word-break: break-word;
}

.service-badges {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* 服务类型徽章 - 次要样式 */
.service-type {
  padding: 4px 10px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* 账户徽章 - 强调样式 */
.account-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--accent-dark);
  color: white;
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.service-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.meta-item svg {
  opacity: 0.7;
}

/* 服务卡片主体 */
.service-card-body {
  padding: 1.25rem 1.5rem;
}

.service-status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.service-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  animation: pulse 2s infinite;
}

.status-live {
  background: #F5FAF5;
  color: var(--accent-success);
}

.status-live .status-indicator {
  background: var(--accent-success);
}

.status-suspended {
  background: #FDF5F5;
  color: var(--accent-danger);
}

.status-suspended .status-indicator {
  background: var(--accent-danger);
  animation: none;
}

.service-url {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: #F5FAF5;
  color: var(--accent-success);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
  transition: all 0.2s ease;
}

.service-url:hover {
  opacity: 0.8;
}

/* 服务信息网格 */
.service-info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
  margin-bottom: 1.25rem;
  padding: 1rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 500;
}

.info-value {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
}

/* 旧版样式兼容 */
.service-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}

.service-title h3 {
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.service-account {
  font-size: 13px;
  color: var(--text-secondary);
}

.status-active {
  background: #F5FAF5;
  color: var(--accent-success);
}

.service-info {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
  margin-bottom: 1rem;
  padding: 1rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
}

.service-actions {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
}

.action-btn {
  min-width: 0;
  padding: 9px 12px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-btn.primary {
  background: var(--accent-dark);
  color: white;
}

.action-btn.primary:hover:not(:disabled) {
  opacity: 0.9;
}

.action-btn.secondary {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.action-btn.secondary:hover:not(:disabled) {
  background: var(--border-light);
  color: var(--text-primary);
}

/* 服务卡片功能按钮 - 统一样式规范 */

/* 第一排操作按钮: deploy/suspend/restart/env-vars - 统一带边框样式 */
.action-btn.deploy-btn,
.action-btn.suspend-btn,
.action-btn.restart-btn,
.action-btn.env-vars-btn {
  background: #FDF8F3;
  color: var(--accent-warning);
  border: 1px solid var(--accent-warning);
}

.action-btn.deploy-btn:hover:not(:disabled),
.action-btn.suspend-btn:hover:not(:disabled),
.action-btn.restart-btn:hover:not(:disabled),
.action-btn.env-vars-btn:hover:not(:disabled) {
  background: var(--accent-warning);
  color: white;
}

/* resume 按钮 - 成功色 */
.action-btn.resume-btn {
  background: #F5FAF5;
  color: var(--accent-success);
  border: 1px solid var(--accent-success);
}

.action-btn.resume-btn:hover:not(:disabled) {
  background: var(--accent-success);
  color: white;
}

/* 第二排操作按钮: instances/deploys/events/logs - 次要样式 */
.action-btn.instances-btn,
.action-btn.deploys-btn,
.action-btn.events-btn,
.action-btn.logs-btn {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-light);
}

.action-btn.instances-btn:hover:not(:disabled),
.action-btn.deploys-btn:hover:not(:disabled),
.action-btn.events-btn:hover:not(:disabled),
.action-btn.logs-btn:hover:not(:disabled) {
  background: var(--border-light);
  color: var(--text-primary);
  border-color: var(--border-medium);
}

/* 加载状态 */
.loading {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 4rem;
  color: var(--text-secondary);
  gap: 1rem;
}

.spinner,
.loading-spinner {
  width: 36px;
  height: 36px;
  border: 2px solid var(--border-light);
  border-top-color: var(--accent-terracotta);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 模态框 */
.modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(45, 45, 45, 0.4);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
  opacity: 0;
  visibility: hidden;
  transition: all 0.2s ease;
}

.modal.show {
  opacity: 1;
  visibility: visible;
}

.modal-content {
  background: var(--bg-surface);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-light);
  width: 90%;
  max-width: 680px;
  max-height: 80vh;
  overflow: hidden;
  transform: scale(0.95);
  transition: all 0.2s ease;
}

.modal.show .modal-content {
  transform: scale(1);
}

.modal-header {
  padding: 1.5rem;
  border-bottom: 1px solid var(--border-light);
}

.modal-title-section {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.modal-title {
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.modal-service-info {
  font-size: 14px;
  color: var(--text-secondary);
  margin-top: 0.5rem;
}

.modal-service-info strong {
  color: var(--text-primary);
  font-weight: 500;
}

.modal-header h2 {
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal-close {
  width: 32px;
  height: 32px;
  border: none;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  color: var(--text-secondary);
}

.modal-close:hover {
  background: var(--border-light);
  color: var(--text-primary);
}

.modal-body {
  padding: 1.5rem;
  overflow-y: auto;
  max-height: calc(80vh - 130px);
}

/* 环境变量列表 */
.env-var-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.env-var-item {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.75rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
}

.env-var-key {
  flex: 0 0 150px;
  font-weight: 500;
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

.env-var-value {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-family: var(--font-mono);
  resize: vertical;
  min-height: 36px;
  background: var(--bg-surface);
  color: var(--text-primary);
}

.env-var-btn {
  padding: 6px 10px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.env-var-btn.save {
  background: var(--accent-success);
  color: white;
}

.env-var-btn.delete {
  background: var(--accent-danger);
  color: white;
}

/* 环境变量项增强样式 */
.env-var-item {
  padding: 1rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
  transition: all 0.2s ease;
}

.env-var-item:hover {
  border-color: var(--border-medium);
  box-shadow: var(--shadow-sm);
}

.env-var-item.editing {
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

.env-var-grid {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
}

.env-var-key {
  flex: 0 0 160px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  color: var(--accent-terracotta);
  background: #FDF5F3;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  word-break: break-all;
}

.env-var-value-wrapper {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.env-var-value {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
  padding: 8px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease;
  word-break: break-all;
  overflow: hidden;
}

.env-var-value.masked {
  color: var(--text-muted);
  letter-spacing: 2px;
}

.env-var-value:hover {
  border-color: var(--accent-dark);
  background: var(--bg-paper);
}

.visibility-toggle {
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-light);
  background: var(--bg-surface);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.visibility-toggle:hover {
  background: var(--bg-paper);
  border-color: var(--border-medium);
  color: var(--text-primary);
}

/* 可见状态的切换按钮 */
.visibility-toggle.visible {
  background: var(--accent-terracotta);
  border-color: var(--accent-terracotta);
  color: white;
}

.visibility-toggle.visible:hover {
  opacity: 0.9;
}

.inline-editor {
  display: none;
  flex: 1;
  min-width: 0;
}

.inline-editor.active {
  display: block;
}

.inline-editor-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--accent-dark);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 13px;
  resize: vertical;
  min-height: 38px;
  box-sizing: border-box;
}

.inline-editor-input:focus {
  outline: none;
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

.inline-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.inline-editor-btn {
  padding: 6px 14px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.cancel-edit-btn {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.cancel-edit-btn:hover {
  background: var(--border-light);
  color: var(--text-primary);
}

.save-edit-btn {
  background: var(--accent-dark);
  color: white;
}

.save-edit-btn:hover {
  opacity: 0.9;
}

.env-var-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.env-var-btn {
  height: 32px;
  padding: 0 12px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.env-var-btn.copy-btn {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.env-var-btn.copy-btn:hover {
  background: var(--border-light);
  color: var(--text-primary);
}

.env-var-btn.edit-btn {
  background: #FDF8F3;
  color: var(--accent-warning);
}

.env-var-btn.edit-btn:hover {
  background: var(--accent-warning);
  color: white;
}

.env-var-btn.delete-btn {
  background: #FDF5F5;
  color: var(--accent-danger);
}

.env-var-btn.delete-btn:hover {
  background: var(--accent-danger);
  color: white;
}

/* 事件日志 */
.events-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.event-item {
  padding: 1.25rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
  transition: all 0.2s ease;
}

.event-item:hover {
  border-color: var(--border-medium);
  box-shadow: var(--shadow-sm);
}

.event-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.event-type {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.event-type-badge {
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.event-type-deploy {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.event-type-build {
  background: #FDF8F3;
  color: var(--accent-warning);
}

.event-type-error {
  background: #FDF5F5;
  color: var(--accent-danger);
}

.event-status {
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
}

.event-status-started {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.event-status-succeeded {
  background: #F5FAF5;
  color: var(--accent-success);
}

.event-status-failed {
  background: #FDF5F5;
  color: var(--accent-danger);
}

.event-time {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.event-details {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

/* 部署历史列表 */
.deploys-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.deploy-item {
  padding: 1.25rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
  transition: all 0.2s ease;
}

.deploy-item:hover {
  border-color: var(--border-medium);
  box-shadow: var(--shadow-sm);
}

.deploy-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.deploy-info {
  flex: 1;
  min-width: 0;
}

.deploy-id {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.deploy-id .deploy-label {
  font-size: 12px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.deploy-id code {
  font-size: 12px;
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-primary);
  word-break: break-all;
}

.deploy-commit {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  font-size: 13px;
  flex-wrap: wrap;
}

.deploy-commit code {
  font-size: 11px;
  background: #FDF5F3;
  color: var(--accent-terracotta);
  padding: 2px 6px;
  border-radius: 4px;
}

.deploy-commit .commit-message {
  color: var(--text-primary);
  word-break: break-word;
}

.deploy-status {
  padding: 6px 12px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

.deploy-status-live {
  background: #F5FAF5;
  color: var(--accent-success);
}

.deploy-status-succeeded {
  background: #F5FAF5;
  color: var(--accent-success);
}

.deploy-status-failed {
  background: #FDF5F5;
  color: var(--accent-danger);
}

.deploy-status-canceled {
  background: #FDF8F3;
  color: var(--accent-warning);
}

.deploy-status-building {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.deploy-status-deactivated {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.deploy-status-pending {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.live-indicator {
  width: 8px;
  height: 8px;
  background: var(--accent-success);
  border-radius: 50%;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.deploy-meta {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 0.75rem;
}

.deploy-time {
  display: flex;
  align-items: center;
  gap: 4px;
}

.deploy-duration {
  color: var(--text-muted);
}

.deploy-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.deploy-action-btn {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.2s ease;
}

.cancel-deploy-btn {
  background: #FDF5F5;
  color: var(--accent-danger);
  border: 1px solid var(--accent-danger);
}

.cancel-deploy-btn:hover {
  background: var(--accent-danger);
  color: white;
}

.rollback-deploy-btn {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-medium);
}

.rollback-deploy-btn:hover {
  background: var(--accent-dark);
  color: white;
  border-color: var(--accent-dark);
}

.current-live-badge {
  padding: 6px 12px;
  background: #F5FAF5;
  color: var(--accent-success);
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
}

/* 日志样式 */
.logs-toolbar {
  padding: 0.75rem 1.5rem;
  background: var(--bg-paper);
  border-bottom: 1px solid var(--border-light);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.logs-filters {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.filter-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.filter-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.filter-select {
  padding: 6px 28px 6px 10px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  font-size: 13px;
  background: var(--bg-surface);
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236B6B6B' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  min-width: 80px;
  transition: all 0.2s ease;
}

.filter-select:hover {
  border-color: var(--border-medium);
  background-color: var(--bg-paper);
}

.filter-select:focus {
  outline: none;
  border-color: var(--accent-dark);
  box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.08);
}

.refresh-btn {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.refresh-btn:hover {
  background: var(--bg-paper);
  border-color: var(--accent-dark);
  color: var(--text-primary);
}

.refresh-btn:active {
  transform: scale(0.95);
}

.logs-filters select {
  padding: 8px 12px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  font-size: 13px;
  background: var(--bg-surface);
  cursor: pointer;
}

.logs-filters select:focus {
  outline: none;
  border-color: var(--accent-dark);
}

.logs-body {
  padding: 0 !important;
  max-height: calc(80vh - 180px);
}

.logs-container {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 1rem;
  overflow-x: auto;
  overflow-y: auto;
  max-height: calc(80vh - 180px);
}

.log-entry {
  padding: 4px 8px;
  border-radius: 4px;
  margin-bottom: 2px;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-entry:hover {
  background: rgba(255, 255, 255, 0.05);
}

.log-timestamp {
  color: #6a9955;
  margin-right: 8px;
}

.log-level {
  font-weight: 600;
  margin-right: 8px;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
}

.log-level-error {
  background: #f44336;
  color: white;
}

.log-level-warn {
  background: #ff9800;
  color: white;
}

.log-level-info {
  background: #2196f3;
  color: white;
}

.log-level-debug {
  background: #9e9e9e;
  color: white;
}

.log-message {
  color: #d4d4d4;
}

/* 实例样式 */
.instances-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.instance-item {
  padding: 1rem;
  background: var(--bg-paper);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-light);
}

.instance-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}

.instance-id {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
}

.instance-status {
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.instance-status-running {
  background: #F5FAF5;
  color: var(--accent-success);
}

.instance-status-starting {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.instance-status-stopped {
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.instance-meta {
  display: flex;
  gap: 1.5rem;
  font-size: 12px;
  color: var(--text-secondary);
}

.scale-section {
  margin-top: 2rem;
  padding-top: 1.5rem;
  border-top: 2px dashed var(--border-light);
}

.scale-section h3 {
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 1rem;
}

.scale-controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.scale-btn {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  font-size: 18px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.scale-btn:hover {
  border-color: var(--accent-dark);
  color: var(--text-primary);
}

.scale-input {
  width: 60px;
  height: 36px;
  border: 1px solid var(--border-medium);
  border-radius: var(--radius-sm);
  text-align: center;
  font-size: 16px;
  font-weight: 500;
}

.scale-input:focus {
  outline: none;
  border-color: var(--accent-dark);
}

/* 页脚 */
.footer {
  text-align: center;
  padding: 2.5rem 2rem;
  color: var(--text-secondary);
  font-size: 13px;
  border-top: 1px solid var(--border-light);
  background: var(--bg-surface);
}

.footer a {
  color: var(--accent-terracotta);
  text-decoration: none;
  font-weight: 500;
}

/* 响应式 - 中等屏幕 */
@media (max-width: 1200px) {
  .services-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

/* 响应式 - 小屏幕 */
@media (max-width: 768px) {
  .services-grid {
    grid-template-columns: 1fr;
  }

  .notification {
    top: 10px;
    right: 10px;
    left: 10px;
    padding: 0.875rem 1rem;
  }

  .empty-state {
    padding: 2rem 1rem;
  }

  .empty-state-icon {
    width: 60px;
    height: 60px;
  }

  .empty-state h3 {
    font-size: 16px;
  }

  .empty-state p {
    font-size: 13px;
  }


  /* 头部 */
  .header-container {
    padding: 0 1rem;
  }

  .logo h1 {
    font-size: 16px;
  }

  .logo-icon {
    width: 32px;
    height: 32px;
  }

  .logo-icon svg {
    width: 18px;
    height: 18px;
  }

  .header-actions {
    gap: 0.5rem;
  }

  .header-link,
  .logout-btn {
    height: 32px;
    padding: 0 10px;
    font-size: 12px;
  }

  .header-link svg,
  .logout-btn svg {
    width: 14px;
    height: 14px;
  }

  /* 统计栏 */
  .stats-bar {
    flex-direction: row;
    align-items: center;
    padding: 1rem;
    gap: 1rem;
  }

  .stats-content {
    flex-direction: row;
    gap: 1rem;
    justify-content: flex-start;
    flex: 1;
    min-width: 0;
  }

  .stat-item {
    padding: 0.5rem;
    min-width: auto;
  }

  .stat-icon {
    width: 36px;
    height: 36px;
  }

  .stat-icon svg {
    width: 18px;
    height: 18px;
  }

  .stat-info h3 {
    font-size: 18px;
  }

  .stat-info p {
    font-size: 11px;
  }

  .add-account-btn {
    padding: 8px 14px;
    font-size: 13px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .filters {
    width: 100%;
    flex-wrap: nowrap;
  }

  .filter-box {
    width: 120px;
    flex-shrink: 0;
  }

  .search-box,
  .filters .search-box {
    flex: 1;
    width: auto;
    min-width: 0;
  }

  .search-input {
    font-size: 16px;
  }

  .account-filter-select {
    padding: 10px 38px 10px 14px;
    font-size: 14px;
  }

  .search-input {
    padding: 10px 14px 10px 14px;
    font-size: 14px;
  }

  /* 服务网格 */
  .services-grid {
    gap: 1rem;
    padding: 0 0.5rem;
  }

  .service-card {
    border-radius: var(--radius-md);
  }

  .service-card-header {
    padding: 1rem;
  }

  .service-name {
    font-size: 15px;
  }

  .service-badges {
    flex-wrap: wrap;
  }

  .service-type, .account-badge {
    font-size: 10px;
    padding: 3px 6px;
  }

  .service-meta {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .meta-item {
    font-size: 11px;
  }

  .service-card-body {
    padding: 1rem;
  }

  .service-info-grid {
    gap: 0.5rem;
  }

  /* 服务操作按钮 */
  .service-actions {
    grid-template-columns: repeat(4, 1fr);
    gap: 0.375rem;
  }

  .action-btn {
    padding: 8px 6px;
    font-size: 11px;
    border-radius: 6px;
  }

  .action-btn svg {
    width: 14px;
    height: 14px;
  }

  /* 模态框 */
  .modal-content {
    width: 95%;
    max-width: none;
    max-height: 90vh;
    margin: 0.5rem;
    border-radius: 16px;
  }

  .modal-content.modal-large {
    max-width: none;
    max-height: 90vh;
  }

  .modal-header {
    padding: 1rem;
  }

  .modal-title {
    font-size: 18px;
  }

  .modal-close {
    width: 32px;
    height: 32px;
    font-size: 20px;
  }

  .modal-body {
    padding: 1rem;
  }

  /* 环境变量 */
  .env-var-list {
    gap: 0.75rem;
  }

  .env-var-item {
    padding: 0.75rem;
  }

  .env-var-grid {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .env-var-key {
    flex: 0 0 100%;
    font-size: 12px;
  }

  .env-var-value-wrapper {
    flex: 1;
    min-width: 0;
  }

  .env-var-value {
    font-size: 12px;
  }

  .env-var-actions {
    flex-shrink: 0;
  }

  .env-var-btn {
    height: 28px;
    padding: 0 8px;
    font-size: 11px;
  }

  .add-env-var-section h3 {
    font-size: 14px !important;
  }

  .add-env-var-inputs {
    flex-direction: column;
  }

  .add-env-var-field {
    flex: 1;
  }

  .add-env-var-actions {
    flex-direction: column;
  }

  .add-env-var-actions .form-btn {
    width: 100%;
    justify-content: center;
  }

  .add-env-btn {
    padding: 6px 10px;
    font-size: 12px;
  }

  /* 日志工具栏 */
  .logs-toolbar {
    gap: 0.75rem;
    padding: 0.75rem 1rem;
  }

  .logs-filters {
    gap: 0.75rem;
  }

  .filter-label {
    font-size: 10px;
  }

  .filter-select {
    font-size: 12px;
    padding: 6px 24px 6px 8px;
    min-width: 70px;
  }

  .refresh-btn {
    width: 36px;
    height: 36px;
  }

  /* 日志容器 */
  .logs-container {
    font-size: 11px;
    padding: 0.75rem;
  }

  .log-entry {
    padding: 3px 6px;
    font-size: 11px;
  }

  .log-timestamp {
    font-size: 10px;
  }

  /* 部署历史 */
  .deploy-item {
    padding: 0.75rem;
  }

  .deploy-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .deploy-status {
    font-size: 11px;
  }

  .deploy-info {
    flex-direction: column;
    gap: 0.25rem;
  }

  /* 事件日志 */
  .event-item {
    padding: 0.75rem;
  }

  .event-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.375rem;
  }

  /* 实例管理 */
  .instance-item {
    padding: 0.75rem;
  }

  .scale-controls {
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  /* 主内容区 */
  .main-content {
    padding: 1rem 0.5rem;
  }

  .container {
    padding: 0;
  }

  /* 页脚 */
  .footer {
    padding: 1rem;
    font-size: 12px;
  }
}

/* 超小屏幕 - 390px (iPhone 12) 以下 */
@media (max-width: 390px) {
  .header-container {
    padding: 0 0.75rem;
  }

  .logo h1 {
    font-size: 14px;
  }

  .header-link,
  .logout-btn {
    padding: 0 8px;
    font-size: 11px;
  }

  .service-actions {
    grid-template-columns: repeat(2, 1fr);
  }
}
`;

// ============================================================================
// Section 17: 前端共享脚本 (views/sharedScript.js)
// ============================================================================

/**
 * 前端共享脚本（以字符串形式注入到页面 <script> 中）
 *
 * 目标：
 * - 复用 CSRF / headers / 通知 / 转义等逻辑
 * - 提供最小的 API 请求封装
 * - 提供 URL 白名单校验（阻断 javascript: 等危险协议）
 */

const sharedScript = `
// 获取 CSRF Token
function getCsrfToken() {
  const match = document.cookie.match(/csrf_token=([^;]+)/);
  return match ? match[1] : '';
}

function initCsrfForms() {
  const token = getCsrfToken();
  if (!token) return;

  document.querySelectorAll('form[data-csrf-form]').forEach(function(form) {
    const input = form.querySelector('input[name="csrf_token"]');
    if (!input) return;
    input.value = token;
  });
}

// 创建带有 CSRF Token 的请求头
function createHeaders(contentType = 'application/json') {
  const headers = {
    'X-CSRF-Token': getCsrfToken()
  };
  if (contentType) {
    headers['Content-Type'] = contentType;
  }
  return headers;
}

// HTML 转义
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
}

// HTML 属性值转义（与 escapeHtml 一致，显式区分上下文）
function escapeAttribute(text) {
  return escapeHtml(text);
}

// 仅允许 http/https（阻断 javascript:, data: 等）
function sanitizeUrl(url) {
  if (!url) return '';

  try {
    const parsed = new URL(String(url), window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (e) {
    // ignore
  }

  return '';
}

async function readResponseErrorMessage(response) {
  try {
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const data = await response.json();
      if (data && typeof data.error === 'string' && data.error) {
        return data.error;
      }
    }

    const text = await response.text();
    if (text) return text;
  } catch (e) {
    // ignore
  }

  return '请求失败: ' + response.status + ' ' + response.statusText;
}

// 统一的 JSON 请求封装：失败时抛出 Error(message)
async function apiJson(url, options) {
  const opts = options || {};
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body;
  const contentType = Object.prototype.hasOwnProperty.call(opts, 'contentType')
    ? opts.contentType
    : 'application/json';

  const headers = new Headers(opts.headers || {});

  // 写请求默认带 CSRF
  if (!['GET', 'HEAD'].includes(method) && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', getCsrfToken());
  }

  let finalBody;
  if (body !== undefined) {
    if (body === null) {
      finalBody = null;
    } else if (body instanceof FormData) {
      finalBody = body;
    } else {
      if (contentType !== null && contentType !== undefined && !headers.has('Content-Type')) {
        headers.set('Content-Type', contentType);
      }
      finalBody = typeof body === 'string' ? body : JSON.stringify(body);
    }
  }

  const response = await fetch(url, {
    method: method,
    headers: headers,
    body: finalBody
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    throw new Error(await readResponseErrorMessage(response));
  }

  // 兼容非 JSON 响应
  const responseContentType = response.headers.get('Content-Type') || '';
  if (responseContentType.includes('application/json')) {
    return await response.json();
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

// 显示通知（避免把 message 注入到 innerHTML）
function showNotification(message, type) {
  const kind = type || 'success';

  const existingNotifications = document.querySelectorAll('.notification');
  existingNotifications.forEach(function(notification) { notification.remove(); });

  const notification = document.createElement('div');
  notification.className = 'notification ' + kind;

  const icon = kind === 'success'
    ? '<svg class="notification-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12L3.41 13.41L9 19L21 7L19.59 5.59L9 16.17Z" fill="#10b981"/></svg>'
    : '<svg class="notification-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12C2 17.52 6.48 22 12 22C17.52 22 22 17.52 22 12C22 6.48 17.52 2 12 2ZM13 17H11V15H13V17ZM13 13H11V7H13V13Z" fill="#ef4444"/></svg>';

  const content = document.createElement('div');
  content.className = 'notification-content';

  const iconWrapper = document.createElement('div');
  iconWrapper.innerHTML = icon;
  const iconElement = iconWrapper.firstElementChild;
  if (iconElement) {
    content.appendChild(iconElement);
  }

  const text = document.createElement('div');
  text.className = 'notification-text';
  text.textContent = message;
  content.appendChild(text);

  notification.replaceChildren(content);
  document.body.appendChild(notification);

  setTimeout(function() {
    notification.style.animation = 'slideInRight 0.3s ease-out reverse';
    setTimeout(function() { notification.remove(); }, 300);
  }, 4000);
}

document.addEventListener('DOMContentLoaded', function() {
  initCsrfForms();
});
`;

// ============================================================================
// Section 18: 登录页面 (views/login.js)
// ============================================================================


/**
 * 渲染登录页面
 * @param {string} error - 错误信息
 * @returns {Response} - HTML响应
 */
function renderLoginPage(error = '') {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Render Service Management - Login</title>
  <style nonce="__CSP_NONCE__">${loginStyles}</style>
</head>
<body>
  <div class="login-container">
    <div class="logo">
      <div class="logo-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7V12C2 16.5 4.23 20.68 7.62 23.15L12 25L16.38 23.15C19.77 20.68 22 16.5 22 12V7L12 2M12 4.18L19.25 7.8V12C19.25 15.58 17.58 18.85 15 20.75V13.25H9V20.75C6.42 18.85 4.75 15.58 4.75 12V7.8L12 4.18Z" />
        </svg>
      </div>
      <h1>Render Manager</h1>
      <p class="subtitle">登录您的账户</p>
    </div>

    ${error ? `<div class="error-message">${escapeHtml(error)}</div>` : ''}

    <form method="post" action="/login">
      <input type="hidden" name="csrf_token" value="__CSRF_TOKEN__">
      <div class="form-group">
        <label for="username">用户名</label>
        <input type="text" id="username" name="username" required placeholder="输入您的用户名" autocomplete="username">
      </div>
      <div class="form-group">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" required placeholder="输入您的密码" autocomplete="current-password">
      </div>
      <button type="submit">登录</button>
    </form>

    <div class="footer">
      <p>© 2025 Render Service Manager | <a href="https://github.com/ssfun/render-service-manager" target="_blank" rel="noopener noreferrer">@sfun</a></p>
    </div>
  </div>
  <script nonce="__CSP_NONCE__">${sharedScript}</script>
</body>
</html>
  `;

  return htmlResponse(html);
}

// ============================================================================
// Section 19: 仪表盘页面 (views/dashboard.js)
// ============================================================================


/**
 * 渲染仪表盘页面
 * @returns {Response} - HTML响应
 */
function renderDashboard() {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Render Service Management</title>
  <style nonce="__CSP_NONCE__">${dashboardStyles}</style>
</head>
<body>
  <header class="header">
    <div class="header-container">
      <a href="/" class="logo">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
            <path d="M12 2L2 7V12C2 16.5 4.23 20.68 7.62 23.15L12 25L16.38 23.15C19.77 20.68 22 16.5 22 12V7L12 2M12 4.18L19.25 7.8V12C19.25 15.58 17.58 18.85 15 20.75V13.25H9V20.75C6.42 18.85 4.75 15.58 4.75 12V7.8L12 4.18Z" />
          </svg>
        </div>
        <h1>Render Manager</h1>
      </a>
      <div class="header-actions">
        <a href="/accounts" class="header-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
          </svg>
          账户管理
        </a>
        <form action="/logout" method="POST" class="logout-form" data-csrf-form>
          <input type="hidden" name="csrf_token" value="">
          <button type="submit" class="logout-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 21H5C3.89543 21 3 20.1046 3 19V5C3 3.89543 3.89543 3 5 3H9M16 17L21 12M21 12L16 7M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            登出
          </button>
        </form>
      </div>
    </div>
  </header>

  <div class="main-content">
    <div class="container">
      <div class="stats-bar">
        <div class="stats-content">
          <div class="stat-item">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20 7L12 3L4 7M20 7L12 11M20 7V17L12 21M12 11L4 7M12 11V21M4 7V17L12 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div class="stat-info">
              <h3 id="totalServices">0</h3>
              <p>服务数</p>
            </div>
          </div>
          <div class="stat-item">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="3" fill="currentColor"/>
                <path d="M12 2V4M12 20V22M4.93 4.93L6.34 6.34M17.66 17.66L19.07 19.07M2 12H4M20 12H22M4.93 19.07L6.34 17.66M17.66 6.34L19.07 4.93" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </div>
            <div class="stat-info">
              <h3 id="liveServices">0</h3>
              <p>运行中</p>
            </div>
          </div>
          <div class="stat-item">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
              </svg>
            </div>
            <div class="stat-info">
              <h3 id="totalAccounts">0</h3>
              <p>账户数</p>
            </div>
          </div>
        </div>
        <div class="filters">
          <div class="cache-info-wrapper">
            <span id="cacheInfo" class="cache-info"></span>
            <button type="button" id="refreshBtn" class="refresh-services-btn" title="刷新数据">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
          </div>
          <div class="filter-box">
            <select id="accountFilter" class="account-filter-select">
              <option value="">全部账户</option>
            </select>
          </div>
          <div class="search-box">
            <input
              type="text"
              id="serviceSearch"
              class="search-input"
              placeholder="搜索服务..."
            >
            <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 21L16.514 16.506L21 21ZM19 10.5C19 15.194 15.194 19 10.5 19C5.806 19 2 15.194 2 10.5C2 5.806 5.806 2 10.5 2C15.194 2 19 5.806 19 10.5Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
      </div>

      <div id="loading" class="loading">
        <div class="spinner"></div>
        <p>加载服务中...</p>
      </div>

      <div id="services-container" class="services-grid" style="display: none;">
        <!-- 服务将在这里动态加载 -->
      </div>
    </div>
  </div>

  <footer class="footer">
    <p>© 2025 Render Service Manager | <a href="https://github.com/ssfun/render-service-manager" target="_blank" rel="noopener noreferrer">@sfun</a></p>
  </footer>

  <!-- 环境变量模态框 -->
  <div id="envVarsModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <div>
          <div class="modal-title-section">
            <h2 class="modal-title">环境变量</h2>
            <button class="modal-close" data-action="close-env-vars-modal" type="button">×</button>
          </div>
          <div class="modal-service-info" id="modalServiceInfo">
            <!-- 服务信息将在这里插入 -->
          </div>
        </div>
      </div>
      <div class="modal-body">
        <div id="envVarsContainer" class="env-var-list">
          <!-- 环境变量将在这里加载 -->
        </div>

        <!-- 添加新环境变量部分 -->
        <div class="add-env-var-section">
          <div class="add-env-var-header">
            <h3>添加新变量</h3>
            <button class="add-env-btn" data-action="toggle-add-form" type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span id="toggleFormText">添加</span>
            </button>
          </div>
          <div class="add-env-var-form" id="addEnvVarForm">
            <div class="add-env-var-inputs">
              <div class="add-env-var-field">
                <label class="add-env-var-label">键</label>
                <input
                  type="text"
                  id="newEnvVarKey"
                  class="add-env-var-input"
                  placeholder="VARIABLE_NAME"
                >
              </div>
              <div class="add-env-var-field add-env-var-field-value">
                <label class="add-env-var-label">值</label>
                <input
                  type="text"
                  id="newEnvVarValue"
                  class="add-env-var-input"
                  placeholder="variable_value"
                >
              </div>
            </div>
            <div class="add-env-var-actions">
              <button class="form-btn secondary" data-action="toggle-add-form" type="button">取消</button>
              <button class="form-btn primary" data-action="add-env-var" type="button">保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 事件日志模态框 -->
  <div id="eventsModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <div>
          <div class="modal-title-section">
            <h2 class="modal-title">事件日志</h2>
            <button class="modal-close" data-action="close-events-modal" type="button">×</button>
          </div>
          <div class="modal-service-info" id="eventsModalServiceInfo">
            <!-- 服务信息将在这里插入 -->
          </div>
        </div>
      </div>
      <div class="modal-body">
        <div id="eventsContainer" class="events-list">
          <!-- 事件日志将在这里加载 -->
        </div>
      </div>
    </div>
  </div>

  <!-- 部署历史模态框 -->
  <div id="deploysModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <div>
          <div class="modal-title-section">
            <h2 class="modal-title">部署历史</h2>
            <button class="modal-close" data-action="close-deploys-modal" type="button">×</button>
          </div>
          <div class="modal-service-info" id="deploysModalServiceInfo">
            <!-- 服务信息将在这里插入 -->
          </div>
        </div>
      </div>
      <div class="modal-body">
        <div id="deploysContainer" class="deploys-list">
          <!-- 部署历史将在这里加载 -->
        </div>
      </div>
    </div>
  </div>

  <!-- 日志查看模态框 -->
  <div id="logsModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <div>
          <div class="modal-title-section">
            <h2 class="modal-title">服务日志</h2>
            <button class="modal-close" data-action="close-logs-modal" type="button">×</button>
          </div>
          <div class="modal-service-info" id="logsModalServiceInfo">
            <!-- 服务信息将在这里插入 -->
          </div>
        </div>
      </div>
      <div class="logs-toolbar">
        <div class="logs-filters">
          <div class="filter-group">
            <label class="filter-label">级别</label>
            <select id="logLevelFilter" class="filter-select">
              <option value="">全部</option>
              <option value="error">错误</option>
              <option value="warn">警告</option>
              <option value="info">信息</option>
              <option value="debug">调试</option>
            </select>
          </div>
          <div class="filter-group">
            <label class="filter-label">数量</label>
            <select id="logLimitFilter" class="filter-select">
              <option value="20" selected>20 条</option>
              <option value="50">50 条</option>
              <option value="100">100 条</option>
              <option value="200">200 条</option>
            </select>
          </div>
        </div>
        <button class="refresh-btn" data-action="refresh-logs" type="button" title="刷新日志">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4C7.58 4 4.01 7.58 4.01 12C4.01 16.42 7.58 20 12 20C15.73 20 18.84 17.45 19.73 14H17.65C16.83 16.33 14.61 18 12 18C8.69 18 6 15.31 6 12C6 8.69 8.69 6 12 6C13.66 6 15.14 6.69 16.22 7.78L13 11H20V4L17.65 6.35Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
      <div class="modal-body logs-body">
        <div id="logsContainer" class="logs-container">
          <!-- 日志将在这里加载 -->
        </div>
      </div>
    </div>
  </div>

  <!-- 实例管理模态框 -->
  <div id="instancesModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <div>
          <div class="modal-title-section">
            <h2 class="modal-title">实例管理</h2>
            <button class="modal-close" data-action="close-instances-modal" type="button">×</button>
          </div>
          <div class="modal-service-info" id="instancesModalServiceInfo">
            <!-- 服务信息将在这里插入 -->
          </div>
        </div>
      </div>
      <div class="modal-body">
        <div id="instancesContainer" class="instances-container">
          <!-- 实例信息将在这里加载 -->
        </div>
        <div class="scale-section" id="scaleSection" style="display: none;">
          <h3>扩缩容</h3>
          <div class="scale-controls">
            <button class="scale-btn" data-action="adjust-scale" data-delta="-1" type="button">-</button>
            <input type="number" id="scaleInput" min="0" max="10" value="1" class="scale-input">
            <button class="scale-btn" data-action="adjust-scale" data-delta="1" type="button">+</button>
            <button class="action-btn primary" data-action="apply-scale" type="button">应用</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="__CSP_NONCE__">${sharedScript}\n${dashboardScript}</script>
</body>
</html>
  `;

  return htmlResponse(html);
}

// ============================================================================
// Section 20: 账户管理页面 (views/accounts.js)
// ============================================================================


/**
 * 账户管理页面脚本
 */
const accountsScript = `
let accounts = [];
let editingAccountId = null;


// 格式化日期
function formatDate(dateString) {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// 获取账户列表
async function fetchAccounts() {
  const loading = document.getElementById('loading');
  const container = document.getElementById('accounts-container');

  loading.style.display = 'flex';
  container.style.display = 'none';

  try {
    const response = await fetch('/api/accounts');
    if (!response.ok) {
      throw new Error('获取账户列表失败');
    }

    accounts = await response.json();
    renderAccounts();
  } catch (error) {
    console.error('获取账户失败:', error);
    showNotification(error.message, 'error');
  } finally {
    loading.style.display = 'none';
    container.style.display = 'block';
  }
}

// 渲染账户列表
function renderAccounts() {
  const container = document.getElementById('accountsList');
  const totalAccounts = document.getElementById('totalAccounts');

  totalAccounts.textContent = accounts.length;

  if (accounts.length === 0) {
    container.innerHTML = \`
      <div class="empty-state">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5">
          <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/>
        </svg>
        <h3>暂无账户</h3>
        <p>添加您的第一个 Render 账户开始管理服务</p>
        <button class="add-account-btn" type="button" data-action="open-add-modal" style="margin-top: 1.5rem;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          添加账户
        </button>
      </div>
    \`;
    return;
  }

  container.innerHTML = accounts.map(account => \`
    <div class="service-card account-card">
      <div class="service-card-header">
        <div class="service-header-top">
          <h3 class="service-name">\${escapeHtml(account.name)}</h3>
          <div class="service-badges">
            <span class="account-type-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z"/>
              </svg>
              \${account.ownerType === 'team' ? '团队' : '个人'}
            </span>
          </div>
        </div>
        <div class="service-meta">
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            创建于 \${formatDate(account.createdAt)}
          </div>
          \${account.updatedAt ? \`
          <div class="meta-item">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 4v6h6M23 20v-6h-6M20.49 9A9 9 0 105.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/>
            </svg>
            更新于 \${formatDate(account.updatedAt)}
          </div>
          \` : ''}
        </div>
      </div>
      <div class="service-card-body">
        <div class="account-owner-badge">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>
          </svg>
          <span>\${escapeHtml(account.email)}</span>
        </div>
        <div class="account-info-grid">
          <div class="account-info-item">
            <span class="account-info-label">账户 ID</span>
            <span class="account-info-value id-value">\${escapeHtml(account.id)}</span>
          </div>
          <div class="account-info-item">
            <span class="account-info-label">API Key</span>
            <span class="account-info-value api-key-preview">\${escapeHtml(account.apiKeyPreview)}</span>
          </div>
          <div class="account-info-item full-width">
            <span class="account-info-label">所有者</span>
            <span class="account-info-value">\${escapeHtml(account.ownerName || '')}</span>
          </div>
        </div>
        <div class="service-actions">
          <button class="action-btn secondary" type="button" data-action="open-edit-modal" data-account-id="\${escapeHtml(account.id)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            编辑
          </button>
          <button class="action-btn danger" type="button" data-action="delete-account" data-account-id="\${escapeHtml(account.id)}" data-account-name="\${escapeHtml(account.name)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
            删除
          </button>
        </div>
      </div>
    </div>
  \`).join('');
}

// 打开添加账户模态框
function openAddModal() {
  editingAccountId = null;
  document.getElementById('modalTitle').textContent = '添加账户';
  document.getElementById('accountName').value = '';
  document.getElementById('accountApiKey').value = '';
  document.getElementById('apiKeyHint').style.display = 'none';
  document.getElementById('testResult').innerHTML = '';
  document.getElementById('accountModal').classList.add('show');
}

// 打开编辑账户模态框
function openEditModal(accountId) {
  const account = accounts.find(a => a.id === accountId);
  if (!account) return;

  editingAccountId = accountId;
  document.getElementById('modalTitle').textContent = '编辑账户';
  document.getElementById('accountName').value = account.name;
  document.getElementById('accountApiKey').value = '';
  document.getElementById('apiKeyHint').style.display = 'block';
  document.getElementById('testResult').innerHTML = '';
  document.getElementById('accountModal').classList.add('show');
}

// 关闭模态框
function closeAccountModal() {
  document.getElementById('accountModal').classList.remove('show');
  editingAccountId = null;
}

// 测试 API Key 连接
async function testConnection() {
  const apiKey = document.getElementById('accountApiKey').value.trim();
  const testBtn = document.getElementById('testBtn');
  const testResult = document.getElementById('testResult');

  if (!apiKey) {
    showNotification('请先输入 API Key', 'error');
    return;
  }

  testBtn.disabled = true;
  testBtn.textContent = '测试中...';
  testResult.innerHTML = '<div class="test-loading">正在验证...</div>';

  try {
    const response = await fetch('/api/accounts/test', {
      method: 'POST',
      headers: createHeaders(),
      body: JSON.stringify({ apiKey })
    });

    const result = await response.json();

    if (result.success) {
      testResult.innerHTML = \`
        <div class="test-success">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#10b981">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
          </svg>
          <div class="test-info">
            <div class="test-title">连接成功!</div>
            <div class="test-detail">用户: \${escapeHtml(result.ownerName)}</div>
            <div class="test-detail">邮箱: \${escapeHtml(result.ownerEmail)}</div>
            <div class="test-detail">类型: \${result.ownerType === 'user' ? '个人账户' : '团队账户'}</div>
          </div>
        </div>
      \`;
    } else {
      testResult.innerHTML = \`
        <div class="test-error">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="#ef4444">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
          </svg>
          <span>\${escapeHtml(result.error || '连接失败')}</span>
        </div>
      \`;
    }
  } catch (error) {
    console.error('测试连接失败:', error);
    testResult.innerHTML = \`
      <div class="test-error">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="#ef4444">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
        <span>测试连接出错</span>
      </div>
    \`;
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = '测试连接';
  }
}

// 保存账户
async function saveAccount(event) {
  event.preventDefault();

  const name = document.getElementById('accountName').value.trim();
  const apiKey = document.getElementById('accountApiKey').value.trim();
  const submitBtn = document.getElementById('submitBtn');

  if (!name) {
    showNotification('请输入账户名称', 'error');
    return;
  }

  if (!editingAccountId && !apiKey) {
    showNotification('请输入 API Key', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '保存中...';

  try {
    let response;

    if (editingAccountId) {
      // 更新账户
      const updateData = { name };
      if (apiKey) {
        updateData.apiKey = apiKey;
      }

      response = await fetch('/api/accounts/' + editingAccountId, {
        method: 'PUT',
        headers: createHeaders(),
        body: JSON.stringify(updateData)
      });
    } else {
      // 添加账户
      response = await fetch('/api/accounts', {
        method: 'POST',
        headers: createHeaders(),
        body: JSON.stringify({ name, apiKey })
      });
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || '操作失败');
    }

    const result = await response.json();
    showNotification('账户 "' + result.name + '" ' + (editingAccountId ? '更新' : '添加') + '成功', 'success');
    closeAccountModal();
    await fetchAccounts();
  } catch (error) {
    console.error('保存账户失败:', error);
    showNotification(error.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = '保存账户';
  }
}

// 删除账户
async function deleteAccount(accountId, accountName) {
  if (!confirm('确定要删除账户 "' + accountName + '" 吗？\\n\\n此操作不可撤销，删除后该账户下的所有服务将不再显示在管理界面中。')) {
    return;
  }

  try {
    const response = await fetch('/api/accounts/' + accountId, {
      method: 'DELETE',
      headers: createHeaders(null)
    });

    if (!response.ok && response.status !== 204) {
      const error = await response.json();
      throw new Error(error.error || '删除失败');
    }

    showNotification('账户 "' + accountName + '" 已删除', 'success');
    await fetchAccounts();
  } catch (error) {
    console.error('删除账户失败:', error);
    showNotification(error.message, 'error');
  }
}

// 处理模态框外的点击
document.addEventListener('click', function(event) {
  const modal = document.getElementById('accountModal');
  if (event.target === modal) {
    closeAccountModal();
  }
});

// 处理 Escape 键
document.addEventListener('keydown', function(event) {
  if (event.key === 'Escape') {
    const modal = document.getElementById('accountModal');
    if (modal.classList.contains('show')) {
      closeAccountModal();
    }
  }
});

function initEventDelegation() {
  document.addEventListener('click', function(event) {
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;

    const action = actionElement.dataset.action;

    switch (action) {
      case 'open-add-modal':
        openAddModal();
        break;
      case 'open-edit-modal': {
        const accountId = actionElement.dataset.accountId;
        if (!accountId) return;
        openEditModal(accountId);
        break;
      }
      case 'delete-account': {
        const accountId = actionElement.dataset.accountId;
        const accountName = actionElement.dataset.accountName;
        if (!accountId || !accountName) return;
        deleteAccount(accountId, accountName);
        break;
      }
      case 'close-account-modal':
        closeAccountModal();
        break;
      case 'test-connection':
        testConnection();
        break;
      default:
        break;
    }
  });

  const accountForm = document.getElementById('accountForm');
  accountForm?.addEventListener('submit', function(event) {
    saveAccount(event);
  });
}

// 初始化页面
document.addEventListener('DOMContentLoaded', function() {
  initEventDelegation();
  fetchAccounts();
});
`;

/**
 * 渲染账户管理页面
 * @returns {Response} - HTML响应
 */
function renderAccountsPage() {
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>账户管理 - Render Service Manager</title>
  <style nonce="__CSP_NONCE__">${dashboardStyles}</style>
</head>
<body>
  <header class="header">
    <div class="header-container">
      <a href="/" class="logo">
        <div class="logo-icon">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
            <path d="M12 2L2 7V12C2 16.5 4.23 20.68 7.62 23.15L12 25L16.38 23.15C19.77 20.68 22 16.5 22 12V7L12 2M12 4.18L19.25 7.8V12C19.25 15.58 17.58 18.85 15 20.75V13.25H9V20.75C6.42 18.85 4.75 15.58 4.75 12V7.8L12 4.18Z" />
          </svg>
        </div>
        <h1>Render Manager</h1>
      </a>
      <div class="header-actions">
        <a href="/" class="header-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>
            <polyline points="9,22 9,12 15,12 15,22"/>
          </svg>
          仪表盘
        </a>
        <form action="/logout" method="POST" class="logout-form" data-csrf-form>
          <input type="hidden" name="csrf_token" value="">
          <button type="submit" class="logout-btn">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 21H5C3.89543 21 3 20.1046 3 19V5C3 3.89543 3.89543 3 5 3H9M16 17L21 12M21 12L16 7M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            登出
          </button>
        </form>
      </div>
    </div>
  </header>

  <div class="main-content">
    <div class="container">
      <div class="stats-bar">
        <div class="stats-content">
          <div class="stat-item">
            <div class="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
              </svg>
            </div>
            <div class="stat-info">
              <h3 id="totalAccounts">0</h3>
              <p>账户数</p>
            </div>
          </div>
        </div>
        <button class="add-account-btn" type="button" data-action="open-add-modal">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          添加账户
        </button>
      </div>

      <div id="loading" class="loading">
        <div class="spinner"></div>
        <p>加载账户中...</p>
      </div>

      <div id="accounts-container" style="display: none;">
        <div class="services-grid" id="accountsList">
          <!-- 账户将在这里动态加载 -->
        </div>
      </div>
    </div>
  </div>

  <footer class="footer">
    <p>© 2025 Render Service Manager | <a href="https://github.com/ssfun/render-service-manager" target="_blank" rel="noopener noreferrer">@sfun</a></p>
  </footer>

  <!-- 添加/编辑账户模态框 -->
  <div id="accountModal" class="modal">
    <div class="modal-content">
      <div class="modal-header">
        <div class="modal-title-section">
          <h2 class="modal-title" id="modalTitle">添加账户</h2>
          <button class="modal-close" type="button" data-action="close-account-modal">×</button>
        </div>
      </div>
      <div class="modal-body">
        <form id="accountForm">
          <div class="form-group">
            <label class="form-label" for="accountName">账户名称</label>
            <input type="text" id="accountName" class="form-input" placeholder="为此账户起一个易于识别的名称" required>
          </div>

          <div class="form-group">
            <label class="form-label" for="accountApiKey">Render API Key</label>
            <div class="test-btn-row">
              <input type="text" id="accountApiKey" class="form-input api-key-input" placeholder="rnd_xxxxxxxxxx">
              <button type="button" id="testBtn" class="action-btn secondary" data-action="test-connection">
                测试连接
              </button>
            </div>
            <p class="form-hint" id="apiKeyHint" style="display: none;">留空表示不修改 API Key</p>
            <div id="testResult"></div>
          </div>

          <div class="form-actions">
            <button type="button" class="action-btn secondary" data-action="close-account-modal">取消</button>
            <button type="submit" id="submitBtn" class="action-btn primary">保存账户</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <script nonce="__CSP_NONCE__">${sharedScript}\n${accountsScript}</script>
</body>
</html>
  `;

  return htmlResponse(html);
}

// ============================================================================
// Section 21: 仪表盘前端脚本 (views/dashboardScript.js)
// ============================================================================

/**
 * 仪表盘前端 JavaScript
 */
const dashboardScript = `
let currentServiceId = '';
let currentAccountId = '';
let currentServiceName = '';
let allEnvVars = [];
let allServices = [];
let isFormVisible = false;
let editingKey = null;
let lastCachedAt = null;

// 禁止/恢复 body 滚动
function lockBodyScroll() {
  document.body.style.overflow = 'hidden';
}

function unlockBodyScroll() {
  document.body.style.overflow = '';
}

// 格式化缓存时间
function formatCacheTime(cachedAt) {
  if (!cachedAt) return '';

  const now = Date.now();
  const diffMs = now - cachedAt;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffMinutes < 1) {
    return '刚刚';
  } else if (diffMinutes < 60) {
    return diffMinutes + ' 分钟前';
  } else {
    const date = new Date(cachedAt);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
}

// 更新缓存信息显示
function updateCacheInfo(cachedAt) {
  lastCachedAt = cachedAt;
  const cacheInfo = document.getElementById('cacheInfo');
  if (cacheInfo && cachedAt) {
    cacheInfo.textContent = '更新于 ' + formatCacheTime(cachedAt);
  }
}

// 定期更新缓存显示时间
setInterval(function() {
  if (lastCachedAt) {
    updateCacheInfo(lastCachedAt);
  }
}, 30000);

// 从API获取服务
async function fetchServices(forceRefresh) {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('spinning');
  }

  try {
    const url = forceRefresh ? '/api/services?refresh=true' : '/api/services';
    const response = await apiJson(url);

    // 处理新的响应格式
    if (response && typeof response === 'object' && Array.isArray(response.services)) {
      allServices = response.services;
      updateCacheInfo(response.cachedAt);
    } else if (Array.isArray(response)) {
      // 兼容旧格式
      allServices = response;
    }

    populateAccountFilter(allServices);
    renderServices(allServices);
    applyFilters();
    updateStats();

    document.getElementById('loading').style.display = 'none';
    document.getElementById('services-container').style.display = 'grid';

    if (forceRefresh) {
      showNotification('数据已刷新', 'success');
    }
  } catch (error) {
    console.error('获取服务出错:', error);
    document.getElementById('loading').style.display = 'none';
    showNotification('加载服务出错: ' + (error?.message || String(error)), 'error');
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('spinning');
    }
  }
}

// 在UI中渲染服务
function renderServices(services) {
  const container = document.getElementById('services-container');
  container.innerHTML = '';

  if (services.length === 0) {
    container.innerHTML = \`
      <div class="empty-state" style="grid-column: 1 / -1;">
        <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 7L12 3L4 7M20 7L12 11M20 7V17L12 21M12 11L4 7M12 11V21M4 7V17L12 21" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <h3>未找到服务</h3>
        <p>请先前往<a href="/accounts" style="color: #3b82f6; text-decoration: underline;">账户管理</a>添加您的 Render 账户。</p>
      </div>
    \`;
    return;
  }

  services.forEach(service => {
    const serviceCard = createServiceCard(service);
    container.appendChild(serviceCard);
  });
}

// 创建服务卡片元素
function createServiceCard(service) {
  const card = document.createElement('div');
  card.className = 'service-card';
  card.setAttribute('data-name', (service?.name || '').toLowerCase());
  card.setAttribute('data-account', (service?.accountName || '').toLowerCase());
  card.setAttribute('data-account-name', service?.accountName || '');

  const statusClass = service?.suspended === 'suspended' ? 'status-suspended' : 'status-live';
  const statusText = service?.suspended === 'suspended' ? '已暂停' : '运行中';

  const updatedDate = service?.updatedAt ? new Date(service.updatedAt).toLocaleDateString() : 'N/A';

  const header = document.createElement('div');
  header.className = 'service-card-header';

  const headerTop = document.createElement('div');
  headerTop.className = 'service-header-top';

  const nameEl = document.createElement('h3');
  nameEl.className = 'service-name';
  nameEl.textContent = service?.name || '';

  const badges = document.createElement('div');
  badges.className = 'service-badges';

  const typeBadge = document.createElement('span');
  typeBadge.className = 'service-type';
  typeBadge.textContent = service?.type || '';

  const accountBadge = document.createElement('span');
  accountBadge.className = 'account-badge';
  accountBadge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 4C14.21 4 16 5.79 16 8C16 10.21 14.21 12 12 12C9.79 12 8 10.21 8 8C8 5.79 9.79 4 12 4M12 14C16.42 14 20 15.79 20 18V20H4V18C4 15.79 7.58 14 12 14Z" fill="currentColor"/></svg> ';
  accountBadge.appendChild(document.createTextNode(service?.accountName || ''));

  badges.appendChild(typeBadge);
  badges.appendChild(accountBadge);

  headerTop.appendChild(nameEl);
  headerTop.appendChild(badges);

  const meta = document.createElement('div');
  meta.className = 'service-meta';

  const updatedItem = document.createElement('div');
  updatedItem.className = 'meta-item';
  updatedItem.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2ZM16.2 16.2L11 13V7H12.5V12.2L17 14.9L16.2 16.2Z" fill="currentColor"/></svg> ';
  updatedItem.appendChild(document.createTextNode('更新于 ' + updatedDate));

  const regionItem = document.createElement('div');
  regionItem.className = 'meta-item';
  regionItem.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C15.31 2 18 4.66 18 7.95C18 12.41 12 19 12 19S6 12.41 6 7.95C6 4.66 8.69 2 12 2M12 6C10.9 6 10 6.9 10 8C10 9.1 10.9 10 12 10C13.1 10 14 9.1 14 8C14 6.9 13.1 6 12 6Z" fill="currentColor"/></svg> ';
  regionItem.appendChild(document.createTextNode(service?.region || 'N/A'));

  meta.appendChild(updatedItem);
  meta.appendChild(regionItem);

  header.appendChild(headerTop);
  header.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'service-card-body';

  const statusRow = document.createElement('div');
  statusRow.className = 'service-status-row';

  const status = document.createElement('div');
  status.className = 'service-status ' + statusClass;

  const indicator = document.createElement('div');
  indicator.className = 'status-indicator';

  status.appendChild(indicator);
  status.appendChild(document.createTextNode(statusText));
  statusRow.appendChild(status);

  if (service?.url) {
    const safeUrl = sanitizeUrl(service.url);

    const link = document.createElement('a');
    link.className = 'service-url';
    link.href = safeUrl || '#';

    if (safeUrl) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.classList.add('disabled-link');
    }

    link.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M18 13V19C18 20.1 17.1 21 16 21H5C3.9 21 3 20.1 3 19V8C3 6.9 3.9 6 5 6H11M15 3H21M21 3V9M21 3L10 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> ';
    link.appendChild(document.createTextNode('访问服务'));

    statusRow.appendChild(link);
  }

  const infoGrid = document.createElement('div');
  infoGrid.className = 'service-info-grid';

  function appendInfo(label, value) {
    const item = document.createElement('div');
    item.className = 'info-item';

    const labelEl = document.createElement('span');
    labelEl.className = 'info-label';
    labelEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'info-value';
    valueEl.textContent = value;

    item.appendChild(labelEl);
    item.appendChild(valueEl);
    infoGrid.appendChild(item);
  }

  appendInfo('套餐', service?.plan || 'N/A');
  appendInfo('环境', service?.env || 'N/A');
  appendInfo('自动部署', service?.autoDeploy === 'yes' ? '已启用' : '已禁用');

  const idItem = document.createElement('div');
  idItem.className = 'info-item';

  const idLabel = document.createElement('span');
  idLabel.className = 'info-label';
  idLabel.textContent = '服务ID';

  const idValue = document.createElement('span');
  idValue.className = 'info-value';
  idValue.style.fontSize = '12px';
  idValue.style.fontFamily = 'monospace';
  idValue.textContent = service?.id || '';

  idItem.appendChild(idLabel);
  idItem.appendChild(idValue);
  infoGrid.appendChild(idItem);

  const actions = document.createElement('div');
  actions.className = 'service-actions';

  function makeActionButton(className, action, label, svgHtml, disabled) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.dataset.action = action;
    btn.dataset.accountId = String(service?.accountId || '');
    btn.dataset.serviceId = String(service?.id || '');
    btn.dataset.serviceName = String(service?.name || '');
    btn.innerHTML = svgHtml + ' ';
    btn.appendChild(document.createTextNode(label));
    if (disabled) btn.disabled = true;
    return btn;
  }

  actions.appendChild(
    makeActionButton(
      'action-btn deploy-btn',
      'deploy',
      '部署',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L13.09 8.26L18 7L16.74 12L22 13.09L15.74 14L17 19L12 17.74L7 19L8.26 14L2 13.09L8.26 12L7 7L12 8.26V2Z" fill="currentColor"/></svg>',
      service?.suspended === 'suspended'
    )
  );

  if (service?.suspended === 'suspended') {
    actions.appendChild(
      makeActionButton(
        'action-btn resume-btn',
        'resume',
        '恢复',
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 5V19L19 12L8 5Z" fill="currentColor"/></svg>',
        false
      )
    );
  } else {
    actions.appendChild(
      makeActionButton(
        'action-btn suspend-btn',
        'suspend',
        '暂停',
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 19H10V5H6V19ZM14 5V19H18V5H14Z" fill="currentColor"/></svg>',
        false
      )
    );
  }

  actions.appendChild(
    makeActionButton(
      'action-btn restart-btn',
      'restart',
      '重启',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4C7.58 4 4.01 7.58 4.01 12C4.01 16.42 7.58 20 12 20C15.73 20 18.84 17.45 19.73 14H17.65C16.83 16.33 14.61 18 12 18C8.69 18 6 15.31 6 12C6 8.69 8.69 6 12 6C13.66 6 15.14 6.69 16.22 7.78L13 11H20V4L17.65 6.35Z" fill="currentColor"/></svg>',
      service?.suspended === 'suspended'
    )
  );

  actions.appendChild(
    makeActionButton(
      'action-btn env-vars-btn',
      'env',
      '环境',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6H2V20C2 21.1 2.9 22 4 22H18V20H4V6ZM20 2H8C6.9 2 6 2.9 6 4V16C6 17.1 6.9 18 8 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2ZM19 11H15V15H13V11H9V9H13V5H15V9H19V11Z" fill="currentColor"/></svg>',
      false
    )
  );

  // 第二排按钮顺序: instances, deploys, events, logs
  actions.appendChild(
    makeActionButton(
      'action-btn instances-btn',
      'instances',
      '实例',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 8H8V4H4V8ZM10 20H14V16H10V20ZM4 20H8V16H4V20ZM4 14H8V10H4V14ZM10 14H14V10H10V14ZM16 4V8H20V4H16ZM10 8H14V4H10V8ZM16 14H20V10H16V14ZM16 20H20V16H16V20Z" fill="currentColor"/></svg>',
      false
    )
  );

  actions.appendChild(
    makeActionButton(
      'action-btn deploys-btn',
      'deploys',
      '历史',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M13 3C8.03 3 4 7.03 4 12H1L4.89 15.89L4.96 16.03L9 12H6C6 8.13 9.13 5 13 5S20 8.13 20 12S16.87 19 13 19C11.07 19 9.32 18.21 8.06 16.94L6.64 18.36C8.27 19.99 10.51 21 13 21C17.97 21 22 16.97 22 12S17.97 3 13 3ZM12 8V13L16.28 15.54L17 14.33L13.5 12.25V8H12Z" fill="currentColor"/></svg>',
      false
    )
  );

  actions.appendChild(
    makeActionButton(
      'action-btn events-btn',
      'events',
      '事件',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 8V12L15 15M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      false
    )
  );

  actions.appendChild(
    makeActionButton(
      'action-btn logs-btn',
      'logs',
      '日志',
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3H21V21H3V3ZM5 5V19H19V5H5ZM7 7H17V9H7V7ZM7 11H17V13H7V11ZM7 15H13V17H7V15Z" fill="currentColor"/></svg>',
      false
    )
  );

  body.appendChild(statusRow);
  body.appendChild(infoGrid);
  body.appendChild(actions);

  card.appendChild(header);
  card.appendChild(body);

  return card;
}

// 更新统计信息
function updateStats() {
  const totalServices = allServices.length;
  const liveServices = allServices.filter(s => s.suspended !== 'suspended').length;
  const accounts = [...new Set(allServices.map(s => s.accountName))];

  document.getElementById('totalServices').textContent = totalServices;
  document.getElementById('liveServices').textContent = liveServices;
  document.getElementById('totalAccounts').textContent = accounts.length;
}

function populateAccountFilter(services) {
  const select = document.getElementById('accountFilter');
  if (!select) return;

  const selectedValue = select.value;

  const accounts = Array.from(
    new Set((services || []).map(s => s.accountName).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'));

  select.innerHTML = '<option value="">全部账户</option>';

  accounts.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });

  select.value = accounts.includes(selectedValue) ? selectedValue : '';
}

function applyFilters() {
  const searchTerm = (document.getElementById('serviceSearch')?.value || '').toLowerCase();
  const selectedAccount = document.getElementById('accountFilter')?.value || '';

  const serviceCards = document.querySelectorAll('.service-card');

  serviceCards.forEach(card => {
    const name = card.getAttribute('data-name') || '';
    const account = card.getAttribute('data-account') || '';
    const rawAccountName = card.getAttribute('data-account-name') || '';

    const matchesAccount = !selectedAccount || rawAccountName === selectedAccount;
    const matchesSearch = name.includes(searchTerm) || account.includes(searchTerm);

    card.style.display = matchesAccount && matchesSearch ? 'block' : 'none';
  });
}

// 部署服务
async function deployService(accountId, serviceId, serviceName) {
  if (!confirm(\`确定要部署 \${serviceName}?\`)) {
    return;
  }

  try {
    const result = await apiJson('/api/deploy', {
      method: 'POST',
      body: {
        accountId: accountId,
        serviceId: serviceId
      }
    });

    const deployId = result && typeof result.id === 'string' ? result.id : '';
    showNotification(
      deployId
        ? \`已成功触发 \${serviceName} 的部署。部署ID: \${deployId}\`
        : \`已成功触发 \${serviceName} 的部署。\`,
      'success'
    );

    setTimeout(fetchServices, 2000);
  } catch (error) {
    console.error('部署服务出错:', error);
    showNotification('部署服务出错: ' + (error?.message || String(error)), 'error');
  }
}

// 暂停服务
async function suspendService(accountId, serviceId, serviceName) {
  if (!confirm(\`确定要暂停 \${serviceName}?\\n\\n暂停后服务将停止运行，但配置会保留。\`)) {
    return;
  }

  try {
    await apiJson(\`/api/services/\${accountId}/\${serviceId}/suspend\`, {
      method: 'POST'
    });

    showNotification(\`已成功暂停 \${serviceName}\`, 'success');
    setTimeout(fetchServices, 2000);
  } catch (error) {
    console.error('暂停服务出错:', error);
    showNotification('暂停服务出错: ' + (error?.message || String(error)), 'error');
  }
}

// 恢复服务
async function resumeService(accountId, serviceId, serviceName) {
  if (!confirm(\`确定要恢复 \${serviceName}?\`)) {
    return;
  }

  try {
    await apiJson(\`/api/services/\${accountId}/\${serviceId}/resume\`, {
      method: 'POST'
    });

    showNotification(\`已成功恢复 \${serviceName}\`, 'success');
    setTimeout(fetchServices, 2000);
  } catch (error) {
    console.error('恢复服务出错:', error);
    showNotification('恢复服务出错: ' + (error?.message || String(error)), 'error');
  }
}

// 重启服务
async function restartService(accountId, serviceId, serviceName) {
  if (!confirm(\`确定要重启 \${serviceName}?\\n\\n重启将导致服务短暂不可用。\`)) {
    return;
  }

  try {
    await apiJson(\`/api/services/\${accountId}/\${serviceId}/restart\`, {
      method: 'POST'
    });

    showNotification(\`已成功重启 \${serviceName}\`, 'success');
    setTimeout(fetchServices, 2000);
  } catch (error) {
    console.error('重启服务出错:', error);
    showNotification('重启服务出错: ' + (error?.message || String(error)), 'error');
  }
}

// 当前部署模态框的上下文
let currentDeployAccountId = '';
let currentDeployServiceId = '';
let currentDeployServiceName = '';

// 打开部署历史模态框
async function openDeploysModal(accountId, serviceId, serviceName) {
  lockBodyScroll();
  const modal = document.getElementById('deploysModal');
  const container = document.getElementById('deploysContainer');
  const serviceInfo = document.getElementById('deploysModalServiceInfo');

  currentDeployAccountId = accountId;
  currentDeployServiceId = serviceId;
  currentDeployServiceName = serviceName;

  const accountName = allServices.find(s => s.id === serviceId && s.accountId === accountId)?.accountName || accountId;
  serviceInfo.replaceChildren(
    document.createTextNode('查看 '),
    (() => {
      const strong = document.createElement('strong');
      strong.textContent = serviceName;
      return strong;
    })(),
    document.createTextNode(' (' + accountName + ') 的部署历史')
  );

  container.innerHTML = '<div class="loading" style="padding: 2rem;"><div class="loading-spinner"></div><p>加载部署历史中...</p></div>';

  modal.classList.add('show');

  try {
    const deploys = await apiJson(\`/api/deploys/\${accountId}/\${serviceId}\`);
    renderDeploys(deploys);
  } catch (error) {
    console.error('获取部署历史出错:', error);
    container.innerHTML = \`
      <div class="empty-state">
        <h3>加载部署历史出错</h3>
        <p>\${escapeHtml(error?.message || String(error))}</p>
      </div>
    \`;
  }
}

// 渲染部署历史
function renderDeploys(deploys) {
  const container = document.getElementById('deploysContainer');

  if (!deploys || deploys.length === 0) {
    container.innerHTML = \`
      <div class="empty-state">
        <h3>没有部署记录</h3>
        <p>此服务暂无部署历史。</p>
      </div>
    \`;
    return;
  }

  container.innerHTML = '';

  deploys.forEach((item, index) => {
    const deploy = item.deploy || item;
    const deployItem = document.createElement('div');
    deployItem.className = 'deploy-item';

    const deployTime = new Date(deploy.createdAt).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    let statusClass = 'deploy-status-pending';
    let statusText = deploy.status || 'unknown';

    switch (deploy.status) {
      case 'live':
        statusClass = 'deploy-status-live';
        statusText = '运行中';
        break;
      case 'build_succeeded':
        statusClass = 'deploy-status-succeeded';
        statusText = '构建成功';
        break;
      case 'build_failed':
        statusClass = 'deploy-status-failed';
        statusText = '构建失败';
        break;
      case 'update_failed':
        statusClass = 'deploy-status-failed';
        statusText = '更新失败';
        break;
      case 'canceled':
        statusClass = 'deploy-status-canceled';
        statusText = '已取消';
        break;
      case 'build_in_progress':
        statusClass = 'deploy-status-building';
        statusText = '构建中';
        break;
      case 'update_in_progress':
        statusClass = 'deploy-status-building';
        statusText = '更新中';
        break;
      case 'pre_deploy_in_progress':
        statusClass = 'deploy-status-building';
        statusText = '预部署中';
        break;
      case 'pre_deploy_failed':
        statusClass = 'deploy-status-failed';
        statusText = '预部署失败';
        break;
      case 'deactivated':
        statusClass = 'deploy-status-deactivated';
        statusText = '已停用';
        break;
      default:
        statusText = deploy.status?.replace(/_/g, ' ') || '未知';
    }

    // 判断是否可以操作
    const canCancel = ['build_in_progress', 'update_in_progress', 'pre_deploy_in_progress'].includes(deploy.status);
    const canRollback = deploy.status === 'deactivated' || (deploy.status === 'live' && index > 0);
    const isCurrentLive = deploy.status === 'live';

    deployItem.innerHTML = \`
      <div class="deploy-header">
        <div class="deploy-info">
          <div class="deploy-id" title="\${escapeHtml(deploy.id)}">
            <span class="deploy-label">部署 ID:</span>
            <code>\${escapeHtml(deploy.id)}</code>
          </div>
          <div class="deploy-commit" title="\${escapeHtml(deploy.commit?.message || '')}">
            \${deploy.commit?.id ? \`<code>\${escapeHtml(deploy.commit.id.substring(0, 7))}</code>\` : ''}
            \${deploy.commit?.message ? \`<span class="commit-message">\${escapeHtml(deploy.commit.message)}</span>\` : ''}
          </div>
        </div>
        <div class="deploy-status \${statusClass}">
          \${isCurrentLive ? '<span class="live-indicator"></span>' : ''}
          \${statusText}
        </div>
      </div>
      <div class="deploy-meta">
        <span class="deploy-time">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2C6.48 2 2 6.48 2 12S6.48 22 12 22 22 17.52 22 12 17.52 2 12 2ZM16.2 16.2L11 13V7H12.5V12.2L17 14.9L16.2 16.2Z" fill="currentColor"/>
          </svg>
          \${deployTime}
        </span>
        \${deploy.finishedAt ? \`<span class="deploy-duration">耗时: \${formatDuration(deploy.createdAt, deploy.finishedAt)}</span>\` : ''}
      </div>
      <div class="deploy-actions">
        \${canCancel ? \`
          <button class="deploy-action-btn cancel-deploy-btn" data-action="cancel-deploy" data-deploy-id="\${escapeHtml(deploy.id)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z" fill="currentColor"/>
            </svg>
            取消
          </button>
        \` : ''}
        \${canRollback && !isCurrentLive ? \`
          <button class="deploy-action-btn rollback-deploy-btn" data-action="rollback-deploy" data-deploy-id="\${escapeHtml(deploy.id)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.5 8C9.85 8 7.45 9 5.6 10.6L2 7V16H11L7.38 12.38C8.77 11.22 10.54 10.5 12.5 10.5C16.04 10.5 19.05 12.81 20.1 16L22.47 15.22C21.08 11.03 17.15 8 12.5 8Z" fill="currentColor"/>
            </svg>
            回滚到此版本
          </button>
        \` : ''}
        \${isCurrentLive ? '<span class="current-live-badge">当前运行版本</span>' : ''}
      </div>
    \`;

    container.appendChild(deployItem);
  });
}

// 格式化部署耗时
function formatDuration(startTime, endTime) {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end - start;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return \`\${hours}小时\${minutes % 60}分钟\`;
  } else if (minutes > 0) {
    return \`\${minutes}分钟\${seconds % 60}秒\`;
  } else {
    return \`\${seconds}秒\`;
  }
}

// 取消部署
async function cancelDeploy(deployId) {
  if (!confirm('确定要取消此部署？')) {
    return;
  }

  try {
    await apiJson(\`/api/deploys/\${currentDeployAccountId}/\${deployId}/cancel\`, {
      method: 'POST'
    });

    showNotification('部署已取消', 'success');

    // 刷新部署列表
    setTimeout(() => {
      openDeploysModal(currentDeployAccountId, currentDeployServiceId, currentDeployServiceName);
    }, 1000);
  } catch (error) {
    console.error('取消部署出错:', error);
    showNotification('取消部署出错: ' + (error?.message || String(error)), 'error');
  }
}

// 回滚部署
async function rollbackDeploy(deployId) {
  if (!confirm('确定要回滚到此部署版本？\\n\\n这将重新部署此版本的代码。')) {
    return;
  }

  try {
    await apiJson(\`/api/deploys/\${currentDeployAccountId}/\${deployId}/rollback\`, {
      method: 'POST'
    });

    showNotification('已开始回滚部署', 'success');

    // 关闭模态框并刷新服务列表
    closeDeploysModal();
    setTimeout(fetchServices, 2000);
  } catch (error) {
    console.error('回滚部署出错:', error);
    showNotification('回滚部署出错: ' + (error?.message || String(error)), 'error');
  }
}

// 关闭部署历史模态框
function closeDeploysModal() {
  unlockBodyScroll();
  const modal = document.getElementById('deploysModal');
  modal.classList.remove('show');

  currentDeployAccountId = '';
  currentDeployServiceId = '';
  currentDeployServiceName = '';
}

// 日志模态框上下文
let currentLogsAccountId = '';
let currentLogsServiceId = '';
let currentLogsServiceName = '';

// 打开日志模态框
async function openLogsModal(accountId, serviceId, serviceName) {
  lockBodyScroll();
  const modal = document.getElementById('logsModal');
  const container = document.getElementById('logsContainer');
  const serviceInfo = document.getElementById('logsModalServiceInfo');

  currentLogsAccountId = accountId;
  currentLogsServiceId = serviceId;
  currentLogsServiceName = serviceName;

  const accountName = allServices.find(s => s.id === serviceId && s.accountId === accountId)?.accountName || accountId;
  serviceInfo.replaceChildren(
    document.createTextNode('查看 '),
    (() => {
      const strong = document.createElement('strong');
      strong.textContent = serviceName;
      return strong;
    })(),
    document.createTextNode(' (' + accountName + ') 的服务日志')
  );

  container.innerHTML = '<div class="loading" style="padding: 2rem; color: white;"><div class="loading-spinner"></div><p>加载日志中...</p></div>';

  modal.classList.add('show');

  await fetchLogs();
}

// 获取日志
async function fetchLogs() {
  const container = document.getElementById('logsContainer');
  const levelFilter = document.getElementById('logLevelFilter').value;
  const limitFilter = document.getElementById('logLimitFilter').value;

  try {
    let url = \`/api/logs/\${currentLogsAccountId}/\${currentLogsServiceId}?limit=\${limitFilter}\`;
    if (levelFilter) {
      url += \`&level=\${levelFilter}\`;
    }

    const data = await apiJson(url);
    renderLogs(data);
  } catch (error) {
    console.error('获取日志出错:', error);
    container.innerHTML = \`
      <div class="empty-state" style="color: white;">
        <h3>加载日志出错</h3>
        <p>\${escapeHtml(error?.message || String(error))}</p>
      </div>
    \`;
  }
}

// 刷新日志
function refreshLogs() {
  if (currentLogsServiceId) {
    fetchLogs();
  }
}

// 渲染日志
function renderLogs(data) {
  const container = document.getElementById('logsContainer');
  const logs = data.logs || data || [];

  if (!logs || logs.length === 0) {
    container.innerHTML = \`
      <div class="empty-state" style="color: white; padding: 2rem;">
        <h3>暂无日志</h3>
        <p>此服务暂无日志记录，或所选级别没有日志。</p>
      </div>
    \`;
    return;
  }

  container.innerHTML = '';

  logs.forEach(log => {
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';

    const timestamp = log.timestamp ? new Date(log.timestamp).toLocaleString('zh-CN') : '';
    const level = log.level || 'info';
    const message = log.message || log.text || JSON.stringify(log);

    let levelClass = 'log-level-info';
    switch (level.toLowerCase()) {
      case 'error':
        levelClass = 'log-level-error';
        break;
      case 'warn':
      case 'warning':
        levelClass = 'log-level-warn';
        break;
      case 'debug':
        levelClass = 'log-level-debug';
        break;
    }

    logEntry.innerHTML = \`
      <span class="log-timestamp">\${escapeHtml(timestamp)}</span>
      <span class="log-level \${levelClass}">\${escapeHtml(level.toUpperCase())}</span>
      <span class="log-message">\${escapeHtml(message)}</span>
    \`;

    container.appendChild(logEntry);
  });
}

// 关闭日志模态框
function closeLogsModal() {
  unlockBodyScroll();
  const modal = document.getElementById('logsModal');
  modal.classList.remove('show');

  currentLogsAccountId = '';
  currentLogsServiceId = '';
  currentLogsServiceName = '';
}

// 实例管理上下文
let currentInstancesAccountId = '';
let currentInstancesServiceId = '';
let currentInstancesServiceName = '';
let currentInstanceCount = 0;

// 打开实例管理模态框
async function openInstancesModal(accountId, serviceId, serviceName) {
  lockBodyScroll();
  const modal = document.getElementById('instancesModal');
  const container = document.getElementById('instancesContainer');
  const serviceInfo = document.getElementById('instancesModalServiceInfo');
  const scaleSection = document.getElementById('scaleSection');

  currentInstancesAccountId = accountId;
  currentInstancesServiceId = serviceId;
  currentInstancesServiceName = serviceName;

  const accountName = allServices.find(s => s.id === serviceId && s.accountId === accountId)?.accountName || accountId;
  serviceInfo.replaceChildren(
    document.createTextNode('管理 '),
    (() => {
      const strong = document.createElement('strong');
      strong.textContent = serviceName;
      return strong;
    })(),
    document.createTextNode(' (' + accountName + ') 的实例')
  );

  container.innerHTML = '<div class="loading" style="padding: 2rem;"><div class="loading-spinner"></div><p>加载实例信息中...</p></div>';
  scaleSection.style.display = 'none';

  modal.classList.add('show');

  try {
    const instances = await apiJson(\`/api/instances/\${accountId}/\${serviceId}\`);
    renderInstances(instances);
  } catch (error) {
    console.error('获取实例信息出错:', error);
    container.innerHTML = \`
      <div class="empty-state">
        <h3>加载实例信息出错</h3>
        <p>\${escapeHtml(error?.message || String(error))}</p>
      </div>
    \`;
  }
}

// 渲染实例列表
function renderInstances(instances) {
  const container = document.getElementById('instancesContainer');
  const scaleSection = document.getElementById('scaleSection');
  const scaleInput = document.getElementById('scaleInput');

  const instanceList = instances || [];
  currentInstanceCount = instanceList.length;
  scaleInput.value = currentInstanceCount;

  if (instanceList.length === 0) {
    container.innerHTML = \`
      <div class="empty-state">
        <h3>没有运行中的实例</h3>
        <p>此服务当前没有运行中的实例。</p>
      </div>
    \`;
    scaleSection.style.display = 'block';
    return;
  }

  container.innerHTML = '';

  instanceList.forEach((item, index) => {
    const instance = item.instance || item;
    const instanceItem = document.createElement('div');
    instanceItem.className = 'instance-item';

    let statusClass = 'instance-status-running';
    let statusText = instance.status || '运行中';

    switch (instance.status?.toLowerCase()) {
      case 'running':
        statusClass = 'instance-status-running';
        statusText = '运行中';
        break;
      case 'starting':
        statusClass = 'instance-status-starting';
        statusText = '启动中';
        break;
      case 'stopped':
        statusClass = 'instance-status-stopped';
        statusText = '已停止';
        break;
    }

    const createdAt = instance.createdAt ? new Date(instance.createdAt).toLocaleString('zh-CN') : 'N/A';

    instanceItem.innerHTML = \`
      <div class="instance-header">
        <div class="instance-id">实例 #\${index + 1} - \${escapeHtml(instance.id?.substring(0, 12) || 'N/A')}...</div>
        <div class="instance-status \${statusClass}">\${statusText}</div>
      </div>
      <div class="instance-meta">
        <span>创建时间: \${createdAt}</span>
        \${instance.region ? \`<span>区域: \${escapeHtml(instance.region)}</span>\` : ''}
      </div>
    \`;

    container.appendChild(instanceItem);
  });

  scaleSection.style.display = 'block';
}

// 调整实例数量
function adjustScale(delta) {
  const scaleInput = document.getElementById('scaleInput');
  let value = parseInt(scaleInput.value, 10) || 0;
  value = Math.max(0, Math.min(10, value + delta));
  scaleInput.value = value;
}

// 应用扩缩容
async function applyScale() {
  const scaleInput = document.getElementById('scaleInput');
  const numInstances = parseInt(scaleInput.value, 10);

  if (isNaN(numInstances) || numInstances < 0) {
    showNotification('请输入有效的实例数量', 'error');
    return;
  }

  if (numInstances === currentInstanceCount) {
    showNotification('实例数量未改变', 'error');
    return;
  }

  if (!confirm(\`确定要将实例数量从 \${currentInstanceCount} 调整为 \${numInstances}？\`)) {
    return;
  }

  try {
    await apiJson(\`/api/services/\${currentInstancesAccountId}/\${currentInstancesServiceId}/scale\`, {
      method: 'POST',
      body: { numInstances }
    });

    showNotification(\`服务已扩缩容至 \${numInstances} 个实例\`, 'success');

    // 刷新实例列表
    setTimeout(() => {
      openInstancesModal(currentInstancesAccountId, currentInstancesServiceId, currentInstancesServiceName);
    }, 2000);
  } catch (error) {
    console.error('扩缩容出错:', error);
    showNotification('扩缩容出错: ' + (error?.message || String(error)), 'error');
  }
}

// 关闭实例管理模态框
function closeInstancesModal() {
  unlockBodyScroll();
  const modal = document.getElementById('instancesModal');
  modal.classList.remove('show');

  currentInstancesAccountId = '';
  currentInstancesServiceId = '';
  currentInstancesServiceName = '';
  currentInstanceCount = 0;
}

// 打开事件日志模态框
async function openEventsModal(accountId, serviceId, serviceName) {
  lockBodyScroll();
  const modal = document.getElementById('eventsModal');
  const container = document.getElementById('eventsContainer');
  const serviceInfo = document.getElementById('eventsModalServiceInfo');

  const accountName = allServices.find(s => s.id === serviceId && s.accountId === accountId)?.accountName || accountId;
  serviceInfo.replaceChildren(
    document.createTextNode('查看 '),
    (() => {
      const strong = document.createElement('strong');
      strong.textContent = serviceName;
      return strong;
    })(),
    document.createTextNode(' (' + accountName + ') 的最近事件')
  );

  container.innerHTML = '<div class="loading" style="padding: 2rem;"><div class="loading-spinner"></div><p>加载事件日志中...</p></div>';

  modal.classList.add('show');

  try {
    const events = await apiJson(\`/api/events/\${accountId}/\${serviceId}\`);
    renderEvents(events);
  } catch (error) {
    console.error('获取事件日志出错:', error);
    container.innerHTML = \`
      <div class="empty-state">
        <h3>加载事件日志出错</h3>
        <p>\${escapeHtml(error?.message || String(error))}</p>
      </div>
    \`;
  }
}

// 渲染事件日志
function renderEvents(events) {
  const container = document.getElementById('eventsContainer');

  if (!events || !Array.isArray(events) || events.length === 0) {
    container.innerHTML = \`
      <div class="empty-state">
        <h3>没有事件日志</h3>
        <p>此服务暂无事件记录。</p>
      </div>
    \`;
    return;
  }

  container.innerHTML = '';

  events.forEach(item => {
    const event = item.event;
    const eventItem = document.createElement('div');
    eventItem.className = 'event-item';

    const eventTime = new Date(event.timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const rawEventType = typeof event.type === 'string' ? event.type : '';
    let eventTypeText = escapeHtml(rawEventType.replace(/_/g, ' ').toUpperCase());
    let eventTypeBadgeClass = 'event-type-deploy';
    let statusHtml = '';

    if (rawEventType.includes('deploy')) {
      eventTypeBadgeClass = 'event-type-deploy';

      if (event.details && event.details.deployStatus) {
        const status = event.details.deployStatus;
        let statusClass = 'event-status-started';
        let statusText = status.toUpperCase();

        if (status === 'succeeded') {
          statusClass = 'event-status-succeeded';
          statusText = '成功';
        } else if (status === 'failed') {
          statusClass = 'event-status-failed';
          statusText = '失败';
        } else if (status === 'started') {
          statusClass = 'event-status-started';
          statusText = '开始';
        }

        statusHtml = \`<div class="event-status \${statusClass}">\${statusText}</div>\`;
      }
    } else if (rawEventType.includes('build')) {
      eventTypeBadgeClass = 'event-type-build';
    } else if (rawEventType.includes('error') || rawEventType.includes('fail')) {
      eventTypeBadgeClass = 'event-type-error';
    }

    eventItem.innerHTML = \`
      <div class="event-header">
        <div class="event-type">
          <span class="event-type-badge \${eventTypeBadgeClass}">\${eventTypeText}</span>
          \${statusHtml}
        </div>
        <div class="event-time">\${eventTime}</div>
      </div>
      <div class="event-details">
        <div>事件ID: \${escapeHtml(event.id)}</div>
        \${event.details && event.details.deployId ? \`<div>部署ID: \${escapeHtml(event.details.deployId)}</div>\` : ''}
      </div>
    \`;

    container.appendChild(eventItem);
  });
}

// 关闭事件日志模态框
function closeEventsModal() {
  unlockBodyScroll();
  const modal = document.getElementById('eventsModal');
  modal.classList.remove('show');
}

// 打开环境变量模态框
async function openEnvVarsModal(accountId, serviceId, serviceName) {
  lockBodyScroll();
  currentServiceId = serviceId;
  currentServiceName = serviceName;
  currentAccountId = accountId;

  const modal = document.getElementById('envVarsModal');
  const container = document.getElementById('envVarsContainer');
  const serviceInfo = document.getElementById('modalServiceInfo');

  const accountName = allServices.find(s => s.id === serviceId && s.accountId === accountId)?.accountName || accountId;
  serviceInfo.replaceChildren(
    document.createTextNode('管理 '),
    (() => {
      const strong = document.createElement('strong');
      strong.textContent = serviceName;
      return strong;
    })(),
    document.createTextNode(' (' + accountName + ') 的变量')
  );

  container.innerHTML = '<div class="loading" style="padding: 2rem;"><div class="loading-spinner"></div><p>加载环境变量中...</p></div>';
  resetAddForm();

  modal.classList.add('show');

  try {
    const envVars = await apiJson(\`/api/env-vars/\${currentAccountId}/\${currentServiceId}\`);
    allEnvVars = envVars;
    renderEnvVars(envVars);
  } catch (error) {
    console.error('获取环境变量出错:', error);
    container.innerHTML = \`
      <div class="empty-state">
        <h3>加载变量出错</h3>
        <p>\${escapeHtml(error?.message || String(error))}</p>
      </div>
    \`;
  }
}

// 渲染环境变量
function renderEnvVars(envVars) {
  const container = document.getElementById('envVarsContainer');

  if (envVars.length === 0) {
    container.innerHTML = \`
      <div class="empty-state">
        <h3>没有环境变量</h3>
        <p>此服务尚未设置任何环境变量。<br>点击"添加变量"创建您的第一个环境变量。</p>
      </div>
    \`;
    return;
  }

  container.innerHTML = '';

  envVars.forEach(item => {
    const envVar = item.envVar;
    const envVarItem = document.createElement('div');
    envVarItem.className = 'env-var-item';
    envVarItem.dataset.key = envVar.key;

    envVarItem.innerHTML = \`
      <div class="env-var-grid">
        <div class="env-var-key">\${escapeHtml(envVar.key)}</div>
        <div class="env-var-value-wrapper">
          <div class="env-var-value masked" data-role="value" data-action="start-inline-edit" title="点击编辑">••••••••••••••••</div>
          <button class="visibility-toggle" data-action="toggle-visibility" title="切换可见性">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 12S5 4 12 4S23 12 23 12S19 20 12 20S1 12 1 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <div class="inline-editor" data-role="editor">
            <textarea class="inline-editor-input" data-role="input">\${escapeHtml(envVar.value)}</textarea>
            <div class="inline-editor-actions">
              <button class="inline-editor-btn cancel-edit-btn" data-action="cancel-inline-edit">取消</button>
              <button class="inline-editor-btn save-edit-btn" data-action="save-inline-edit">保存</button>
            </div>
          </div>
        </div>
        <div class="env-var-actions">
          <button class="env-var-btn copy-btn" data-action="copy-value" title="复制值">复制</button>
          <button class="env-var-btn delete-btn" data-action="delete-env-var">删除</button>
        </div>
      </div>
    \`;

    container.appendChild(envVarItem);
  });
}

// 切换值的可见性
function toggleValueVisibility(key) {
  const item = document.querySelector('.env-var-item[data-key="' + CSS.escape(key) + '"]');
  if (!item) return;

  const valueElement = item.querySelector('[data-role="value"]');
  const toggleBtn = item.querySelector('.visibility-toggle');
  if (!valueElement) return;

  const isCurrentlyMasked = valueElement.classList.contains('masked');

  if (isCurrentlyMasked) {
    const envVar = allEnvVars.find(item => item.envVar.key === key);
    if (envVar) {
      valueElement.textContent = envVar.envVar.value;
      valueElement.classList.remove('masked');
      toggleBtn?.classList.add('visible');
    }
  } else {
    valueElement.textContent = '••••••••••••••••';
    valueElement.classList.add('masked');
    toggleBtn?.classList.remove('visible');
  }
}

// 开始内联编辑
function startInlineEdit(key) {
  if (editingKey && editingKey !== key) {
    cancelInlineEdit(editingKey);
  }

  editingKey = key;
  const item = document.querySelector('.env-var-item[data-key="' + CSS.escape(key) + '"]');
  if (!item) return;

  const valueWrapper = item.querySelector('.env-var-value-wrapper');
  const valueDiv = item.querySelector('[data-role="value"]');
  const editor = item.querySelector('[data-role="editor"]');
  const input = item.querySelector('[data-role="input"]');
  const visibilityToggle = valueWrapper?.querySelector('.visibility-toggle');

  if (!valueWrapper || !valueDiv || !editor || !input || !visibilityToggle) return;

  item.classList.add('editing');

  valueDiv.style.display = 'none';
  visibilityToggle.style.display = 'none';
  editor.classList.add('active');

  input.focus();
  input.select();

  autoResizeTextarea(input);
}

// 取消内联编辑
function cancelInlineEdit(key) {
  editingKey = null;
  const item = document.querySelector('.env-var-item[data-key="' + CSS.escape(key) + '"]');
  if (!item) return;

  const valueWrapper = item.querySelector('.env-var-value-wrapper');
  const valueDiv = item.querySelector('[data-role="value"]');
  const editor = item.querySelector('[data-role="editor"]');
  const input = item.querySelector('[data-role="input"]');
  const visibilityToggle = valueWrapper?.querySelector('.visibility-toggle');

  if (!valueWrapper || !valueDiv || !editor || !input || !visibilityToggle) return;

  item.classList.remove('editing');

  const originalValue = allEnvVars.find(item => item.envVar.key === key)?.envVar.value || '';
  input.value = originalValue;

  valueDiv.style.display = 'block';
  visibilityToggle.style.display = 'flex';
  editor.classList.remove('active');

  if (valueDiv.classList.contains('masked')) {
    valueDiv.textContent = '••••••••••••••••';
  }
}

// 保存内联编辑
async function saveInlineEdit(key) {
  const item = document.querySelector('.env-var-item[data-key="' + CSS.escape(key) + '"]');
  const input = item?.querySelector('[data-role="input"]');
  const newValue = input?.value.trim();

  if (newValue === '') {
    showNotification('值不能为空。', 'error');
    return;
  }

  const originalValue = allEnvVars.find(item => item.envVar.key === key)?.envVar.value || '';
  if (newValue === originalValue) {
    cancelInlineEdit(key);
    return;
  }

  try {
    await apiJson(\`/api/env-vars/\${currentAccountId}/\${currentServiceId}/\${encodeURIComponent(key)}\`, {
      method: 'PUT',
      body: {
        value: newValue
      }
    });

    const envVarIndex = allEnvVars.findIndex(item => item.envVar.key === key);
    if (envVarIndex !== -1) {
      allEnvVars[envVarIndex].envVar.value = newValue;
    }

    const item = document.querySelector('.env-var-item[data-key="' + CSS.escape(key) + '"]');
    const valueDiv = item?.querySelector('[data-role="value"]');
    if (valueDiv) {
      valueDiv.textContent = '••••••••••••••••';
      valueDiv.classList.add('masked');
    }

    cancelInlineEdit(key);

    showNotification(\`环境变量 '\${key}' 更新成功。\`, 'success');

  } catch (error) {
    console.error('更新环境变量出错:', error);
    showNotification('更新环境变量出错: ' + (error?.message || String(error)), 'error');
  }
}

// 删除环境变量
async function deleteEnvVar(key) {
  if (!confirm(\`确定要删除环境变量 '\${key}'?\\n\\n此操作无法撤销。\`)) {
    return;
  }

  try {
    await apiJson(\`/api/env-vars/\${currentAccountId}/\${currentServiceId}/\${encodeURIComponent(key)}\`, {
      method: 'DELETE',
      contentType: null
    });

    allEnvVars = allEnvVars.filter(item => item.envVar.key !== key);
    renderEnvVars(allEnvVars);

    showNotification(\`环境变量 '\${key}' 删除成功。\`, 'success');

  } catch (error) {
    console.error('删除环境变量出错:', error);
    showNotification('删除环境变量出错: ' + (error?.message || String(error)), 'error');
  }
}

// 复制值到剪贴板
async function copyValue(key) {
  const envVar = allEnvVars.find(item => item.envVar.key === key);
  if (!envVar) return;

  const value = envVar.envVar.value;

  try {
    await navigator.clipboard.writeText(value);
    showNotification(\`已复制 \${key} 的值到剪贴板\`, 'success');
  } catch (err) {
    console.error('复制失败: ', err);
    const textArea = document.createElement('textarea');
    textArea.value = value;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
    showNotification(\`已复制 \${key} 的值到剪贴板\`, 'success');
  }
}

// 切换添加表单可见性
function toggleAddForm() {
  const form = document.getElementById('addEnvVarForm');
  const toggleText = document.getElementById('toggleFormText');

  isFormVisible = !isFormVisible;

  if (isFormVisible) {
    form.classList.add('show');
    toggleText.textContent = '取消';
    setTimeout(() => {
      document.getElementById('newEnvVarKey').focus();
    }, 300);
  } else {
    form.classList.remove('show');
    toggleText.textContent = '添加变量';
    resetAddForm();
  }
}

// 重置添加表单
function resetAddForm() {
  document.getElementById('newEnvVarKey').value = '';
  document.getElementById('newEnvVarValue').value = '';
  isFormVisible = false;
  const form = document.getElementById('addEnvVarForm');
  const toggleText = document.getElementById('toggleFormText');
  form.classList.remove('show');
  toggleText.textContent = '添加变量';
}


// 处理编辑器中的键盘快捷键
function handleEditorKeyDown(event, key) {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    saveInlineEdit(key);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancelInlineEdit(key);
  }

  setTimeout(() => autoResizeTextarea(event.target), 0);
}

function getServiceActionPayloadFromButton(button) {
  if (!button) return null;

  const accountId = button.dataset.accountId;
  const serviceId = button.dataset.serviceId;
  const serviceName = button.dataset.serviceName;
  const action = button.dataset.action;

  if (!accountId || !serviceId || !serviceName || !action) return null;
  return { accountId, serviceId, serviceName, action };
}

function getEnvVarKeyFromEventTarget(target) {
  const envVarItem = target?.closest?.('.env-var-item');
  const key = envVarItem?.dataset?.key;
  return key || null;
}

function initEventDelegation() {
  const servicesContainer = document.getElementById('services-container');
  servicesContainer?.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    const payload = getServiceActionPayloadFromButton(button);
    if (!payload) return;

    switch (payload.action) {
      case 'deploy':
        await deployService(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'resume':
        await resumeService(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'suspend':
        await suspendService(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'restart':
        await restartService(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'env':
        await openEnvVarsModal(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'deploys':
        await openDeploysModal(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'logs':
        await openLogsModal(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'instances':
        await openInstancesModal(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      case 'events':
        await openEventsModal(payload.accountId, payload.serviceId, payload.serviceName);
        break;
      default:
        break;
    }
  });

  const envVarsModal = document.getElementById('envVarsModal');
  envVarsModal?.addEventListener('click', async (event) => {
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;

    const action = actionElement.dataset.action;

    if (action === 'cancel-deploy' || action === 'rollback-deploy') {
      const deployId = actionElement.dataset.deployId;
      if (!deployId) return;

      if (action === 'cancel-deploy') {
        await cancelDeploy(deployId);
      } else {
        await rollbackDeploy(deployId);
      }
      return;
    }

    if (action === 'toggle-add-form') {
      toggleAddForm();
      return;
    }

    if (action === 'add-env-var') {
      await addEnvVar();
      return;
    }

    const key = getEnvVarKeyFromEventTarget(actionElement);
    if (!key) return;

    switch (action) {
      case 'toggle-visibility':
        toggleValueVisibility(key);
        break;
      case 'start-inline-edit':
        startInlineEdit(key);
        break;
      case 'cancel-inline-edit':
        cancelInlineEdit(key);
        break;
      case 'save-inline-edit':
        await saveInlineEdit(key);
        break;
      case 'copy-value':
        await copyValue(key);
        break;
      case 'delete-env-var':
        await deleteEnvVar(key);
        break;
      default:
        break;
    }
  });

  envVarsModal?.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (target.dataset.role !== 'input') return;

    const key = getEnvVarKeyFromEventTarget(target);
    if (!key) return;

    handleEditorKeyDown(event, key);
  });

  const closeHandlers = {
    'close-env-vars-modal': closeEnvVarsModal,
    'close-events-modal': closeEventsModal,
    'close-deploys-modal': closeDeploysModal,
    'close-logs-modal': closeLogsModal,
    'close-instances-modal': closeInstancesModal,
  };

  document.addEventListener('click', async (event) => {
    const actionElement = event.target.closest('[data-action]');
    if (!actionElement) return;

    const action = actionElement.dataset.action;

    if (action === 'refresh-logs') {
      refreshLogs();
      return;
    }

    if (action === 'adjust-scale') {
      const delta = parseInt(actionElement.dataset.delta || '0', 10);
      adjustScale(delta);
      return;
    }

    if (action === 'apply-scale') {
      await applyScale();
      return;
    }

    const closeHandler = closeHandlers[action];
    if (closeHandler) {
      closeHandler();
    }
  });

  const accountFilter = document.getElementById('accountFilter');
  accountFilter?.addEventListener('change', () => {
    applyFilters();
  });

  const searchInput = document.getElementById('serviceSearch');
  searchInput?.addEventListener('input', () => {
    applyFilters();
  });

  const logLevelFilter = document.getElementById('logLevelFilter');
  logLevelFilter?.addEventListener('change', () => {
    refreshLogs();
  });

  const logLimitFilter = document.getElementById('logLimitFilter');
  logLimitFilter?.addEventListener('change', () => {
    refreshLogs();
  });

  const envVarKeyInput = document.getElementById('newEnvVarKey');
  const envVarValueInput = document.getElementById('newEnvVarValue');

  function handleEnvVarFormKeydown(event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      addEnvVar();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      toggleAddForm();
    }
  }

  envVarKeyInput?.addEventListener('keydown', handleEnvVarFormKeydown);
  envVarValueInput?.addEventListener('keydown', handleEnvVarFormKeydown);
}

// 自动调整文本区域大小
function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.max(38, textarea.scrollHeight) + 'px';
}

// 添加环境变量
async function addEnvVar() {
  const key = document.getElementById('newEnvVarKey').value.trim();
  const value = document.getElementById('newEnvVarValue').value.trim();

  if (!key || !value) {
    showNotification('请输入环境变量的键和值。', 'error');
    return;
  }

  const existingVar = allEnvVars.find(item => item.envVar.key === key);
  if (existingVar) {
    if (!confirm(\`环境变量 '\${key}' 已存在。是否要更新它？\`)) {
      return;
    }
  }

  try {
    const result = await apiJson(\`/api/env-vars/\${currentAccountId}/\${currentServiceId}/\${encodeURIComponent(key)}\`, {
      method: 'PUT',
      body: {
        value: value
      }
    });

    // 直接使用返回结果更新本地数据，避免重复请求
    // API 返回格式是 { key, value }，需要包装成 { envVar: { key, value } }
    const wrappedResult = { envVar: result };
    if (existingVar) {
      // 更新已存在的变量
      const envVarIndex = allEnvVars.findIndex(item => item.envVar.key === key);
      if (envVarIndex !== -1) {
        allEnvVars[envVarIndex] = wrappedResult;
      }
    } else {
      // 添加新变量
      allEnvVars.push(wrappedResult);
    }
    renderEnvVars(allEnvVars);

    resetAddForm();

    showNotification(\`环境变量 '\${key}' \${existingVar ? '更新' : '添加'}成功。\`, 'success');

  } catch (error) {
    console.error('添加环境变量出错:', error);
    showNotification('添加环境变量出错: ' + (error?.message || String(error)), 'error');
  }
}

// 关闭环境变量模态框
function closeEnvVarsModal() {
  unlockBodyScroll();
  if (editingKey) {
    cancelInlineEdit(editingKey);
  }

  const modal = document.getElementById('envVarsModal');
  modal.classList.remove('show');

  resetAddForm();

  currentServiceId = '';
  currentAccountId = '';
  currentServiceName = '';
  allEnvVars = [];
}


// 处理Escape键
document.addEventListener('keydown', function(event) {
  if (event.key !== 'Escape') return;

  const envVarsModal = document.getElementById('envVarsModal');
  const eventsModal = document.getElementById('eventsModal');
  const deploysModal = document.getElementById('deploysModal');
  const logsModal = document.getElementById('logsModal');
  const instancesModal = document.getElementById('instancesModal');

  if (envVarsModal.classList.contains('show')) {
    if (editingKey) {
      cancelInlineEdit(editingKey);
    } else {
      closeEnvVarsModal();
    }
  } else if (eventsModal.classList.contains('show')) {
    closeEventsModal();
  } else if (deploysModal.classList.contains('show')) {
    closeDeploysModal();
  } else if (logsModal.classList.contains('show')) {
    closeLogsModal();
  } else if (instancesModal.classList.contains('show')) {
    closeInstancesModal();
  }
});

// 点击 modal 遮罩关闭（避免依赖 inline onclick）
document.addEventListener('click', function(event) {
  const envVarsModal = document.getElementById('envVarsModal');
  const eventsModal = document.getElementById('eventsModal');
  const deploysModal = document.getElementById('deploysModal');
  const logsModal = document.getElementById('logsModal');
  const instancesModal = document.getElementById('instancesModal');

  if (event.target === envVarsModal) {
    closeEnvVarsModal();
  } else if (event.target === eventsModal) {
    closeEventsModal();
  } else if (event.target === deploysModal) {
    closeDeploysModal();
  } else if (event.target === logsModal) {
    closeLogsModal();
  } else if (event.target === instancesModal) {
    closeInstancesModal();
  }
});

// 初始化页面
document.addEventListener('DOMContentLoaded', () => {
  initEventDelegation();
  fetchServices();

  // 刷新按钮事件
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      fetchServices(true);
    });
  }
});
`;

// ============================================================================
// Section 22: 主入口 - 路由和中间件 (index.js)
// ============================================================================

  handleGetEnvVars,
  handleUpdateAllEnvVars,
  handleUpdateSingleEnvVar,
  handleDeleteEnvVar

  handleGetServiceDetails,
  handleSuspendService,
  handleResumeService,
  handleRestartService,
  handleGetDeploys,
  handleCancelDeploy,
  handleRollbackDeploy

  handleGetInstances,
  handleGetLogs,
  handleScaleService

  handleGetAccounts,
  handleAddAccount,
  handleUpdateAccount,
  handleDeleteAccount,
  handleTestAccount

/**
 * 静态路由配置
 */
const routes = [
  { path: '/login', method: 'POST', handler: handleAuth, csrf: true },
  { path: '/login', method: 'GET', handler: (req, env) => handleMainPage(req, env, true) },
  { path: '/logout', method: 'POST', handler: handleLogout, auth: true },
  { path: '/api/services', method: 'GET', handler: handleGetServices, auth: true },
  { path: '/api/deploy', method: 'POST', handler: handleDeploy, auth: true },
  { path: '/api/accounts', method: 'GET', handler: handleGetAccounts, auth: true },
  { path: '/api/accounts', method: 'POST', handler: handleAddAccount, auth: true },
  { path: '/api/accounts/test', method: 'POST', handler: handleTestAccount, auth: true },
  { path: '/accounts', method: 'GET', handler: handleAccountsPage, auth: true },
  { path: '/', method: 'GET', handler: (req, env) => handleMainPage(req, env) },
];

/**
 * 动态路由配置
 */
const dynamicRoutes = [
  // 账户管理路由
  { pattern: /^\/api\/accounts\/([^\/]+)$/, method: 'PUT', handler: handleUpdateAccount, auth: true },
  { pattern: /^\/api\/accounts\/([^\/]+)$/, method: 'DELETE', handler: handleDeleteAccount, auth: true },
  // 事件和环境变量路由
  { pattern: /^\/api\/events\/([^\/]+)\/([^\/]+)$/, method: 'GET', handler: handleGetEvents, auth: true },
  { pattern: /^\/api\/env-vars\/([^\/]+)\/([^\/]+)$/, method: 'GET', handler: handleGetEnvVars, auth: true },
  { pattern: /^\/api\/env-vars\/([^\/]+)\/([^\/]+)$/, method: 'PUT', handler: handleUpdateAllEnvVars, auth: true },
  { pattern: /^\/api\/env-vars\/([^\/]+)\/([^\/]+)\/(.+)$/, method: 'PUT', handler: handleUpdateSingleEnvVar, auth: true },
  { pattern: /^\/api\/env-vars\/([^\/]+)\/([^\/]+)\/(.+)$/, method: 'DELETE', handler: handleDeleteEnvVar, auth: true },
  // 服务控制路由
  { pattern: /^\/api\/services\/([^\/]+)\/([^\/]+)$/, method: 'GET', handler: handleGetServiceDetails, auth: true },
  { pattern: /^\/api\/services\/([^\/]+)\/([^\/]+)\/suspend$/, method: 'POST', handler: handleSuspendService, auth: true },
  { pattern: /^\/api\/services\/([^\/]+)\/([^\/]+)\/resume$/, method: 'POST', handler: handleResumeService, auth: true },
  { pattern: /^\/api\/services\/([^\/]+)\/([^\/]+)\/restart$/, method: 'POST', handler: handleRestartService, auth: true },
  // 部署管理路由
  { pattern: /^\/api\/deploys\/([^\/]+)\/([^\/]+)$/, method: 'GET', handler: handleGetDeploys, auth: true },
  { pattern: /^\/api\/deploys\/([^\/]+)\/([^\/]+)\/cancel$/, method: 'POST', handler: handleCancelDeploy, auth: true },
  { pattern: /^\/api\/deploys\/([^\/]+)\/([^\/]+)\/rollback$/, method: 'POST', handler: handleRollbackDeploy, auth: true },
  // 监控路由
  { pattern: /^\/api\/instances\/([^\/]+)\/([^\/]+)$/, method: 'GET', handler: handleGetInstances, auth: true },
  { pattern: /^\/api\/logs\/([^\/]+)\/([^\/]+)$/, method: 'GET', handler: handleGetLogs, auth: true },
  { pattern: /^\/api\/services\/([^\/]+)\/([^\/]+)\/scale$/, method: 'POST', handler: handleScaleService, auth: true },
];

/**
 * CSRF 防护
 */
function shouldCheckCsrf(request) {
  const method = request.method.toUpperCase();
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

function isSameOrigin(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('Origin');

  if (origin && origin !== 'null') {
    try {
      const originUrl = new URL(origin);
      return originUrl.origin === requestUrl.origin;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      return refererUrl.origin === requestUrl.origin;
    } catch {
      return false;
    }
  }

  return false;
}

async function getRequestCsrfToken(request) {
  const headerToken = request.headers.get('X-CSRF-Token');
  if (headerToken) return headerToken;

  const contentType = request.headers.get('Content-Type') || '';
  const isForm =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data');

  if (!isForm) return null;

  try {
    const formData = await request.clone().formData();
    const bodyToken = formData.get('csrf_token');
    if (typeof bodyToken === 'string' && bodyToken) {
      return bodyToken;
    }
  } catch {
    // ignore
  }

  try {
    const bodyText = await request.clone().text();
    if (bodyText) {
      const params = new URLSearchParams(bodyText);
      const bodyToken = params.get('csrf_token');
      if (bodyToken) {
        return bodyToken;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

async function verifyCsrf(request) {
  if (!shouldCheckCsrf(request)) return true;

  // 有 Origin/Referer 时要求同源；缺失时仅依赖 token 双提交校验（兼容部分表单 POST）
  const origin = request.headers.get('Origin');
  const referer = request.headers.get('Referer');
  const effectiveOrigin = origin === 'null' ? null : origin;
  if ((effectiveOrigin || referer) && !isSameOrigin(request)) return false;

  const cookieHeader = request.headers.get('Cookie') || '';
  const cookieToken = getCookieValue(cookieHeader, 'csrf_token');
  const requestToken = await getRequestCsrfToken(request);

  // 强制要求 CSRF token 存在且匹配
  if (!cookieToken || !requestToken) return false;
  return cookieToken === requestToken;
}

function getOrCreateCsrfCookie(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const csrfToken = getCookieValue(cookieHeader, 'csrf_token');

  if (csrfToken) {
    return { token: csrfToken, setCookie: null };
  }

  const newToken = generateCsrfToken();
  const secureAttr = getCookieSecurityAttribute(request);
  return {
    token: newToken,
    setCookie: `csrf_token=${newToken}; Path=/${secureAttr}; SameSite=Strict; Max-Age=86400`,
  };
}

async function withCsrfCookie(request, response) {
  const contentType = response.headers.get('Content-Type') || '';
  const isHtml = contentType.startsWith('text/html');
  if (!isHtml) {
    return response;
  }

  const { token, setCookie } = getOrCreateCsrfCookie(request);

  const headers = new Headers(response.headers);
  if (setCookie) {
    headers.append('Set-Cookie', setCookie);
  }

  if (response.body && response.headers.get('Content-Type')?.startsWith('text/html')) {
    const originalText = await response.text();
    const patchedText = originalText.replace(/__CSRF_TOKEN__/g, token || '');
    return new Response(patchedText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * 主请求处理器
 */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 匹配静态路由
  for (const route of routes) {
    if (route.path === path && route.method === method) {
      let sessionSetCookie = null;

      if (route.auth) {
        const { session, setCookie } = await verifySession(request, env, { sliding: true });
        if (!session) {
          return jsonResponse({ error: 'Unauthorized' }, HTTP_STATUS.UNAUTHORIZED);
        }

        const shouldVerifyCsrf = route.csrf !== false;
        if (shouldVerifyCsrf && !(await verifyCsrf(request))) {
          return jsonResponse({ error: 'CSRF validation failed' }, HTTP_STATUS.FORBIDDEN);
        }

        sessionSetCookie = setCookie;
      } else if (route.csrf === true) {
        if (!(await verifyCsrf(request))) {
          return jsonResponse({ error: 'CSRF validation failed' }, HTTP_STATUS.FORBIDDEN);
        }
      }

      let response = await route.handler(request, env, ctx);

      if (sessionSetCookie) {
        const headers = new Headers(response.headers);
        headers.append('Set-Cookie', sessionSetCookie);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return await withCsrfCookie(request, response);
    }
  }

  // 匹配动态路由
  for (const route of dynamicRoutes) {
    const match = path.match(route.pattern);
    if (match && route.method === method) {
      let sessionSetCookie = null;

      if (route.auth) {
        const { session, setCookie } = await verifySession(request, env, { sliding: true });
        if (!session) {
          return jsonResponse({ error: 'Unauthorized' }, HTTP_STATUS.UNAUTHORIZED);
        }

        const shouldVerifyCsrf = route.csrf !== false;
        if (shouldVerifyCsrf && !(await verifyCsrf(request))) {
          return jsonResponse({ error: 'CSRF validation failed' }, HTTP_STATUS.FORBIDDEN);
        }

        sessionSetCookie = setCookie;
      }

      let response = await route.handler(request, match, env);

      if (sessionSetCookie) {
        const headers = new Headers(response.headers);
        headers.append('Set-Cookie', sessionSetCookie);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return await withCsrfCookie(request, response);
    }
  }

  return new Response('Not Found', { status: 404 });
}

// ============================================================================
// Export: Cloudflare Worker 入口
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error('全局错误:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  // 定时任务入口（带超时控制）
  async scheduled(event, env, ctx) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CRON_CONFIG.TIMEOUT_MS);

    ctx.waitUntil(
      handleScheduled(env, controller.signal)
        .finally(() => clearTimeout(timeoutId))
    );
  }
};
