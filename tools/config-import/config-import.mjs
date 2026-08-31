import { randomBytes } from 'node:crypto';

export const REQUIRED_SHEETS = ['联赛配置', '学校信息', '队伍账号映射', '题目映射'];

export const CONFIG_HEADERS = [
  '联赛ID*', '联赛名称*', '赛制*', '罚时(分钟)*', 'CE罚时*', '开始时间*', '比赛时长(分钟)*',
  '封榜时长(分钟)*', '时区*', 'Contest API版本*', '榜单刷新(秒)*', '断联阈值(秒)*', '断联策略*', '备注',
];

export const SCHOOL_HEADERS = [
  '学校ID*', '学校全称*', '学校简称*', '站点ID*', 'Hydro内网地址*', 'Hydro域ID*', '本地比赛ID*',
  'Hydro版本*', '负责人*', '联系电话*', '联系邮箱', '网络联调状态*', '最近联调时间', '备注', '校验结果',
];

export const TEAM_HEADERS = [
  '全局队伍ID*', '学校ID*', '队伍名称*', '队伍类型*', '本地域ID', '本地比赛ID', '本地Hydro UID*',
  '本地Hydro用户名*', 'Hydro显示名', '成员1姓名*', '成员1学号', '成员2姓名', '成员2学号', '成员3姓名',
  '成员3学号', '教练姓名', '座位号', '启用状态*', '备注', '校验结果',
];

export const PROBLEM_HEADERS = [
  '全局题目ID*', '题号标签*', '题目顺序*', '题目名称*', '学校ID*', '本地域ID', '本地比赛ID',
  '本地Hydro PID*', '题目包SHA256*', 'Checker SHA256*', '时限(ms)*', '内存(MB)*', '校验结果',
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PROBLEM_COLORS = [
  { color: 'red', rgb: '#e74c3c' },
  { color: 'blue', rgb: '#3498db' },
  { color: 'green', rgb: '#2ecc71' },
  { color: 'yellow', rgb: '#f1c40f' },
  { color: 'purple', rgb: '#9b59b6' },
  { color: 'teal', rgb: '#1abc9c' },
  { color: 'orange', rgb: '#e67e22' },
  { color: 'gray', rgb: '#34495e' },
  { color: 'pink', rgb: '#ff6b81' },
  { color: 'violet', rgb: '#6c5ce7' },
  { color: 'emerald', rgb: '#00b894' },
  { color: 'azure', rgb: '#0984e3' },
];

export class WorkbookValidationError extends Error {
  constructor(issues) {
    super(`Excel 配置校验失败，共 ${issues.length} 项`);
    this.name = 'WorkbookValidationError';
    this.issues = issues;
  }
}

function text(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    if ('text' in value) return String(value.text).trim();
    if ('result' in value) return text(value.result);
  }
  return String(value).trim();
}

function integer(value, location, issues, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isSafeInteger(raw) || raw < min || raw > max) {
    issues.push(`${location} 必须是 ${min} 到 ${max} 之间的整数`);
    return null;
  }
  return raw;
}

function required(value, location, issues) {
  const result = text(value);
  if (!result) issues.push(`${location} 不能为空`);
  return result;
}

function validateId(value, location, issues) {
  const result = required(value, location, issues);
  if (result && !ID_PATTERN.test(result)) {
    issues.push(`${location} 只能包含字母、数字、点、下划线、冒号、@ 和短横线，且必须以字母或数字开头`);
  }
  return result;
}

function assertUnique(items, keyOf, label, issues) {
  const seen = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) issues.push(`${label} 重复：${key}`);
    else seen.set(key, item);
  }
}

function assertHeaders(rows, sheet, expected, issues) {
  const actual = rows[2] ?? [];
  expected.forEach((header, index) => {
    if (text(actual[index]) !== header) {
      issues.push(`${sheet}!${columnName(index + 1)}3 表头应为“${header}”`);
    }
  });
}

function columnName(index) {
  let value = index;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function dataRows(rows) {
  return rows.slice(3).map((row, index) => ({ row, rowNumber: index + 4 }))
    .filter(({ row }) => row.some((value) => text(value) !== ''));
}

function shanghaiDate(value, location, issues) {
  let parts;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    parts = [
      value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
      value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(),
    ];
  } else {
    const match = text(value).match(/^(\d{4})[-/]?(\d{1,2})[-/]?(\d{1,2})(?:[ T](\d{1,2}):?(\d{2})(?::?(\d{2}))?)?$/);
    if (!match) {
      issues.push(`${location} 必须是有效的北京时间，例如 2026-10-01 09:00`);
      return null;
    }
    parts = [
      Number(match[1]), Number(match[2]), Number(match[3]),
      Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0),
    ];
  }
  const [year, month, day, hour, minute, second] = parts;
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(wallClockUtc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    issues.push(`${location} 不是有效日期时间`);
    return null;
  }
  return new Date(wallClockUtc - 8 * 60 * 60 * 1000);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

function parseCenterUrl(centerUrl, issues) {
  try {
    const url = new URL(centerUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) throw new Error('shape');
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    issues.push('centerUrl 必须是无路径、无账号密码的 HTTP(S) 地址');
    return centerUrl;
  }
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

export function generateSecret(bytes = 36) {
  return randomBytes(bytes).toString('base64url');
}

export function convertWorkbookRows(sheets, options = {}) {
  const issues = [];
  for (const sheet of REQUIRED_SHEETS) {
    if (!Array.isArray(sheets[sheet])) issues.push(`缺少工作表“${sheet}”`);
  }
  if (issues.length) throw new WorkbookValidationError(issues);

  assertHeaders(sheets['联赛配置'], '联赛配置', CONFIG_HEADERS, issues);
  assertHeaders(sheets['学校信息'], '学校信息', SCHOOL_HEADERS, issues);
  assertHeaders(sheets['队伍账号映射'], '队伍账号映射', TEAM_HEADERS, issues);
  assertHeaders(sheets['题目映射'], '题目映射', PROBLEM_HEADERS, issues);

  const configEntries = dataRows(sheets['联赛配置']);
  if (configEntries.length !== 1) issues.push('联赛配置必须且只能填写一行');
  const configRow = configEntries[0]?.row ?? [];
  const leagueId = validateId(configRow[0], '联赛配置!A4 联赛ID', issues);
  const leagueName = required(configRow[1], '联赛配置!B4 联赛名称', issues);
  if (text(configRow[2]) !== 'ACM/ICPC') issues.push('联赛配置!C4 赛制必须为 ACM/ICPC');
  const penaltyMinutes = integer(configRow[3], '联赛配置!D4 罚时', issues, { min: 0, max: 120 });
  if (text(configRow[4]) !== '否') issues.push('联赛配置!E4 必须为“否”（CE 不罚时）');
  const startsAt = shanghaiDate(configRow[5], '联赛配置!F4 开始时间', issues);
  const durationMinutes = integer(configRow[6], '联赛配置!G4 比赛时长', issues, { min: 1, max: 1440 });
  const freezeMinutes = integer(configRow[7], '联赛配置!H4 封榜时长', issues, { min: 1, max: 1440 });
  if (text(configRow[8]) !== 'Asia/Shanghai') issues.push('联赛配置!I4 时区必须为 Asia/Shanghai');
  if (text(configRow[9]) !== '2023-06') issues.push('联赛配置!J4 Contest API 版本必须为 2023-06');
  const refreshSeconds = integer(configRow[10], '联赛配置!K4 榜单刷新', issues, { min: 1, max: 3600 });
  const offlineSeconds = integer(configRow[11], '联赛配置!L4 断联阈值', issues, { min: 5, max: 3600 });
  if (text(configRow[12]) !== '继续发布并标注断联学校') {
    issues.push('联赛配置!M4 断联策略必须为“继续发布并标注断联学校”');
  }
  if (durationMinutes !== null && freezeMinutes !== null && freezeMinutes >= durationMinutes) {
    issues.push('封榜时长必须小于比赛时长，使封榜时间严格位于比赛开始和结束之间');
  }

  const schools = dataRows(sheets['学校信息']).map(({ row, rowNumber }) => {
    const prefix = `学校信息!第${rowNumber}行`;
    const schoolId = validateId(row[0], `${prefix} 学校ID`, issues);
    const fullName = required(row[1], `${prefix} 学校全称`, issues);
    const shortName = required(row[2], `${prefix} 学校简称`, issues);
    const siteId = validateId(row[3], `${prefix} 站点ID`, issues);
    const hydroUrl = required(row[4], `${prefix} Hydro内网地址`, issues);
    const domainId = validateId(row[5], `${prefix} Hydro域ID`, issues);
    const contestId = required(row[6], `${prefix} 本地比赛ID`, issues).toLowerCase();
    if (contestId && !OBJECT_ID_PATTERN.test(contestId)) issues.push(`${prefix} 本地比赛ID必须是24位Hydro ObjectId`);
    const hydroVersion = required(row[7], `${prefix} Hydro版本`, issues);
    if (hydroVersion && hydroVersion !== '5.0.0-beta.9') issues.push(`${prefix} Hydro版本当前必须为 5.0.0-beta.9`);
    required(row[8], `${prefix} 负责人`, issues);
    required(row[9], `${prefix} 联系电话`, issues);
    const networkStatus = required(row[11], `${prefix} 网络联调状态`, issues);
    if (networkStatus && !['未联调', '联调通过', '联调异常'].includes(networkStatus)) {
      issues.push(`${prefix} 网络联调状态不是允许值`);
    }
    return { schoolId, fullName, shortName, siteId, hydroUrl, domainId, contestId, hydroVersion, networkStatus };
  });
  if (!schools.length) issues.push('学校信息至少需要一所学校');
  assertUnique(schools, (item) => item.schoolId, '学校ID', issues);
  assertUnique(schools, (item) => item.siteId, '站点ID', issues);
  const schoolById = new Map(schools.map((school) => [school.schoolId, school]));

  const teamRows = dataRows(sheets['队伍账号映射']).map(({ row, rowNumber }) => {
    const prefix = `队伍账号映射!第${rowNumber}行`;
    const teamId = validateId(row[0], `${prefix} 全局队伍ID`, issues);
    const schoolId = validateId(row[1], `${prefix} 学校ID`, issues);
    const name = required(row[2], `${prefix} 队伍名称`, issues);
    const kind = required(row[3], `${prefix} 队伍类型`, issues);
    if (kind && !['正式', '打星'].includes(kind)) issues.push(`${prefix} 队伍类型必须为“正式”或“打星”`);
    const uid = integer(row[6], `${prefix} 本地Hydro UID`, issues, { min: 1, max: 2_147_483_647 });
    required(row[7], `${prefix} 本地Hydro用户名`, issues);
    required(row[9], `${prefix} 成员1姓名`, issues);
    const enabledText = required(row[17], `${prefix} 启用状态`, issues);
    if (enabledText && !['启用', '停用'].includes(enabledText)) issues.push(`${prefix} 启用状态必须为“启用”或“停用”`);
    if (!schoolById.has(schoolId)) issues.push(`${prefix} 引用了不存在的学校ID ${schoolId}`);
    return { teamId, schoolId, name, kind, uid, enabled: enabledText === '启用' };
  });
  assertUnique(teamRows, (item) => item.teamId, '全局队伍ID', issues);
  const activeTeams = teamRows.filter((team) => team.enabled);
  assertUnique(activeTeams, (item) => `${item.schoolId}\0${item.uid}`, '启用队伍的学校+Hydro UID', issues);

  const problemRows = dataRows(sheets['题目映射']).map(({ row, rowNumber }) => {
    const prefix = `题目映射!第${rowNumber}行`;
    const problemId = validateId(row[0], `${prefix} 全局题目ID`, issues);
    const label = required(row[1], `${prefix} 题号标签`, issues);
    const ordinal = integer(row[2], `${prefix} 题目顺序`, issues, { min: 1, max: 100 });
    const name = required(row[3], `${prefix} 题目名称`, issues);
    const schoolId = validateId(row[4], `${prefix} 学校ID`, issues);
    const pid = integer(row[7], `${prefix} 本地Hydro PID`, issues, { min: 1, max: 2_147_483_647 });
    const packageSha256 = required(row[8], `${prefix} 题目包SHA256`, issues).toLowerCase();
    const checkerSha256 = required(row[9], `${prefix} Checker SHA256`, issues).toLowerCase();
    if (packageSha256 && !SHA256_PATTERN.test(packageSha256)) issues.push(`${prefix} 题目包SHA256必须是64位十六进制`);
    if (checkerSha256 && !SHA256_PATTERN.test(checkerSha256)) issues.push(`${prefix} Checker SHA256必须是64位十六进制`);
    const timeLimitMs = integer(row[10], `${prefix} 时限`, issues, { min: 1, max: 3_600_000 });
    const memoryMb = integer(row[11], `${prefix} 内存`, issues, { min: 1, max: 1_048_576 });
    if (!schoolById.has(schoolId)) issues.push(`${prefix} 引用了不存在的学校ID ${schoolId}`);
    return { problemId, label, ordinal, name, schoolId, pid, packageSha256, checkerSha256, timeLimitMs, memoryMb };
  });
  if (!problemRows.length) issues.push('题目映射至少需要一道题目');
  assertUnique(problemRows, (item) => `${item.schoolId}\0${item.problemId}`, '学校+全局题目ID', issues);
  assertUnique(problemRows, (item) => `${item.schoolId}\0${item.pid}`, '学校+本地Hydro PID', issues);

  const problemDefinitions = new Map();
  for (const item of problemRows) {
    const definition = [item.label, item.ordinal, item.name, item.packageSha256, item.checkerSha256, item.timeLimitMs, item.memoryMb];
    const previous = problemDefinitions.get(item.problemId);
    if (previous && JSON.stringify(previous.definition) !== JSON.stringify(definition)) {
      issues.push(`全局题目 ${item.problemId} 在不同学校的标签、顺序、名称、哈希或资源限制不一致`);
    } else if (!previous) {
      problemDefinitions.set(item.problemId, { item, definition });
    }
  }
  const definitions = [...problemDefinitions.values()].map(({ item }) => item);
  assertUnique(definitions, (item) => item.label, '全局题号标签', issues);
  assertUnique(definitions, (item) => String(item.ordinal), '全局题目顺序', issues);
  for (const school of schools) {
    const mapped = new Set(problemRows.filter((item) => item.schoolId === school.schoolId).map((item) => item.problemId));
    for (const problemId of problemDefinitions.keys()) {
      if (!mapped.has(problemId)) issues.push(`${school.fullName} 缺少全局题目 ${problemId} 的本地PID映射`);
    }
  }

  const centerUrl = parseCenterUrl(options.centerUrl ?? 'http://127.0.0.1:3000', issues);
  const insecureRemote = (() => {
    try {
      return new URL(centerUrl).protocol === 'http:' && !isLoopbackUrl(centerUrl);
    } catch {
      return false;
    }
  })();
  if (insecureRemote && options.allowInsecureHttp !== true) {
    issues.push('非回环中心地址必须使用 HTTPS；受控内网临时联调需显式传入 allowInsecureHttp');
  }
  if (issues.length) throw new WorkbookValidationError(issues);

  const secrets = options.secrets ?? {};
  const siteSecrets = {};
  for (const school of schools) {
    const existing = text(secrets.sites?.[school.siteId]);
    const secret = existing || generateSecret();
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new WorkbookValidationError([`站点 ${school.siteId} 的已有密钥少于32字节`]);
    }
    siteSecrets[school.siteId] = secret;
  }
  const adminToken = text(secrets.admin_token) || generateSecret();
  if (Buffer.byteLength(adminToken, 'utf8') < 32) {
    throw new WorkbookValidationError(['已有中心管理员令牌少于32字节']);
  }

  const endsAt = addMinutes(startsAt, durationMinutes);
  const freezeAt = addMinutes(endsAt, -freezeMinutes);
  const problems = definitions.sort((a, b) => a.ordinal - b.ordinal).map((item, index) => {
    const palette = PROBLEM_COLORS[index % PROBLEM_COLORS.length];
    return {
      problem_id: item.problemId,
      label: item.label,
      name: item.name,
      ordinal: index,
      color: palette.color,
      rgb: palette.rgb,
    };
  });
  const hubConfig = {
    contest: {
      contest_id: leagueId,
      name: leagueName,
      start_time: startsAt.toISOString(),
      end_time: endsAt.toISOString(),
      freeze_time: freezeAt.toISOString(),
      unfreeze_at: null,
      penalty_minutes: penaltyMinutes,
    },
    sites: schools.map((school) => ({
      site_id: school.siteId,
      name: school.shortName,
      school_name: school.fullName,
      enabled: true,
      secret: siteSecrets[school.siteId],
    })),
    teams: activeTeams.map((team) => {
      const school = schoolById.get(team.schoolId);
      return {
        team_id: team.teamId,
        name: team.name,
        school_id: team.schoolId,
        school_name: school.fullName,
        official: team.kind === '正式',
        hidden: false,
      };
    }),
    problems,
    team_mappings: activeTeams.map((team) => {
      const school = schoolById.get(team.schoolId);
      return {
        league_id: leagueId,
        site_id: school.siteId,
        domain_id: school.domainId,
        contest_id: school.contestId,
        local_uid: String(team.uid),
        team_id: team.teamId,
      };
    }),
    problem_mappings: problemRows.map((problem) => {
      const school = schoolById.get(problem.schoolId);
      return {
        league_id: leagueId,
        site_id: school.siteId,
        domain_id: school.domainId,
        contest_id: school.contestId,
        local_pid: String(problem.pid),
        problem_id: problem.problemId,
      };
    }),
  };

  const siteConfigs = Object.fromEntries(schools.map((school) => {
    const localTeams = activeTeams.filter((team) => team.schoolId === school.schoolId);
    const localProblems = problemRows.filter((problem) => problem.schoolId === school.schoolId);
    return [school.siteId, {
      enabled: true,
      centerUrl,
      allowInsecureHttp: insecureRemote && options.allowInsecureHttp === true,
      leagueId,
      siteId: school.siteId,
      sharedSecret: siteSecrets[school.siteId],
      contests: [{
        domainId: school.domainId,
        contestId: school.contestId,
        teamMapping: Object.fromEntries(localTeams.map((team) => [String(team.uid), team.teamId])),
        problemMapping: Object.fromEntries(localProblems.map((problem) => [String(problem.pid), problem.problemId])),
      }],
      cacheTtlMs: refreshSeconds * 1_000,
    }];
  }));

  const offlineAfterMs = offlineSeconds * 1_000;
  const delayedAfterMs = Math.max(1_000, Math.min(offlineAfterMs - 1_000, Math.floor(offlineAfterMs / 2)));

  return {
    hubConfig,
    siteConfigs,
    secrets: { admin_token: adminToken, sites: siteSecrets },
    environment: {
      HYDRO_LEAGUE_HOST: '127.0.0.1',
      HYDRO_LEAGUE_PORT: '3000',
      HYDRO_LEAGUE_ADMIN_TOKEN: adminToken,
      HYDRO_LEAGUE_DELAYED_AFTER_MS: String(delayedAfterMs),
      HYDRO_LEAGUE_OFFLINE_AFTER_MS: String(offlineAfterMs),
    },
    report: {
      league_id: leagueId,
      school_count: schools.length,
      active_team_count: activeTeams.length,
      official_team_count: activeTeams.filter((team) => team.kind === '正式').length,
      starred_team_count: activeTeams.filter((team) => team.kind === '打星').length,
      problem_count: problems.length,
      mapping_count: activeTeams.length + problemRows.length,
      center_url: centerUrl,
      warnings: [
        ...schools.filter((school) => school.networkStatus !== '联调通过')
          .map((school) => `${school.fullName} 尚未标记为联调通过`),
        ...(insecureRemote
          ? ['已显式允许非回环 HTTP，仅限受控内网临时联调；正式部署必须改用 HTTPS']
          : []),
      ],
    },
  };
}
