import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AWARD_HEADERS,
  CONFIG_HEADERS,
  MEDAL_HEADERS,
  PROBLEM_HEADERS,
  SCHOOL_BADGE_HEADER,
  SCHOOL_HEADERS,
  TEAM_GROUPS_HEADER,
  TEAM_HEADERS,
  WorkbookValidationError,
  convertWorkbookRows,
} from './config-import.mjs';

function sheet(headers, rows) {
  return [[], [], headers, ...rows];
}

function validSheets() {
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  return {
    联赛配置: sheet(CONFIG_HEADERS, [[
      'league-2026', '多校程序设计联赛', 'ACM/ICPC', 20, '否', '2026-10-01 09:00', 300,
      60, 'Asia/Shanghai', '2023-06', 10, 60, '继续发布并标注断联学校', '',
    ]]),
    学校信息: sheet(SCHOOL_HEADERS, [
      ['school-a', '甲大学', '甲大', 'site-a', 'http://10.0.0.2', 'system', 'aaaaaaaaaaaaaaaaaaaaaaaa', '5.0.0-beta.9', '负责人甲', '10001', '', '联调通过'],
      ['school-b', '乙大学', '乙大', 'site-b', 'http://10.1.0.2', 'system', 'bbbbbbbbbbbbbbbbbbbbbbbb', '5.0.0-beta.9', '负责人乙', '10002', '', '未联调'],
    ]),
    队伍账号映射: sheet(TEAM_HEADERS, [
      ['team-001', 'school-a', '甲队', '正式', '', '', 101, 'team001', '', '队员甲', '', '', '', '', '', '', 'A01', '启用'],
      ['team-002', 'school-b', '乙队', '打星', '', '', 201, 'team002', '', '队员乙', '', '', '', '', '', '', 'B01', '启用'],
    ]),
    题目映射: sheet(PROBLEM_HEADERS, [
      ['problem-a', 'A', 1, '签到题', 'school-a', '', '', 1001, hashA, hashB, 1000, 256],
      ['problem-a', 'A', 1, '签到题', 'school-b', '', '', 2001, hashA, hashB, 1000, 256],
    ]),
  };
}

test('converts a complete workbook into hub and per-site configs', () => {
  const result = convertWorkbookRows(validSheets(), {
    centerUrl: 'http://127.0.0.1:3000',
    secrets: {
      admin_token: 'admin-token-that-is-at-least-thirty-two-bytes',
      sites: { 'site-a': 'site-a-secret-that-is-at-least-thirty-two-bytes' },
    },
  });
  assert.equal(result.hubConfig.contest.start_time, '2026-10-01T01:00:00.000Z');
  assert.equal(result.hubConfig.contest.end_time, '2026-10-01T06:00:00.000Z');
  assert.equal(result.hubConfig.contest.freeze_time, '2026-10-01T05:00:00.000Z');
  assert.equal(result.hubConfig.teams[0].official, true);
  assert.equal(result.hubConfig.teams[1].official, false);
  assert.equal(result.hubConfig.problems[0].color, 'red');
  assert.equal(result.hubConfig.problems[0].rgb, '#e74c3c');
  assert.equal(result.hubConfig.problem_mappings.length, 2);
  assert.equal(result.siteConfigs['site-a'].contests[0].teamMapping['101'], 'team-001');
  assert.equal(result.siteConfigs['site-b'].contests[0].problemMapping['2001'], 'problem-a');
  assert.equal(result.secrets.sites['site-a'], 'site-a-secret-that-is-at-least-thirty-two-bytes');
  assert.ok(Buffer.byteLength(result.secrets.sites['site-b']) >= 32);
  assert.deepEqual(result.report.warnings, ['乙大学 尚未标记为联调通过']);
  assert.equal('xcpcio_medals' in result.hubConfig.contest, false);
  assert.equal('awards' in result.hubConfig, false);
  assert.equal('groups' in result.hubConfig.teams[0], false);
  assert.equal('badge_url' in result.hubConfig.teams[0], false);
});

test('imports optional school badges, team medal groups, medal counts, and manual awards', () => {
  const sheets = validSheets();
  sheets.学校信息[2] = [...SCHOOL_HEADERS, SCHOOL_BADGE_HEADER];
  sheets.学校信息[3][SCHOOL_HEADERS.length] = 'https://assets.example.edu/badges/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png';
  sheets.学校信息[4][SCHOOL_HEADERS.length] = 'http://assets.example.edu/badges/school-b.jpg';
  sheets.队伍账号映射[2] = [...TEAM_HEADERS, TEAM_GROUPS_HEADER];
  sheets.队伍账号映射[3][TEAM_HEADERS.length] = '2026新生, 本科组';
  sheets.队伍账号映射[4][TEAM_HEADERS.length] = '本科组，邀请队';
  sheets.奖牌设置 = sheet(MEDAL_HEADERS, [
    ['official', 1, 0, 0],
    ['unofficial', 0, 1, 0],
    ['2026新生', 1, 2, 3],
    ['本科组', 2, 4, 6],
  ]);
  sheets.人工奖项 = sheet(AWARD_HEADERS, [
    ['winner', '冠军', 'team-001'],
    ['fight', '顽强拼搏奖', 'team-001，team-002'],
    ['no-recipient-yet', '待定特别奖', ''],
  ]);

  const result = convertWorkbookRows(sheets);
  assert.deepEqual(result.hubConfig.contest.xcpcio_medals, {
    official: { gold: 1, silver: 0, bronze: 0 },
    unofficial: { gold: 0, silver: 1, bronze: 0 },
    '2026新生': { gold: 1, silver: 2, bronze: 3 },
    本科组: { gold: 2, silver: 4, bronze: 6 },
  });
  assert.deepEqual(result.hubConfig.teams[0].groups, ['2026新生', '本科组']);
  assert.equal(
    result.hubConfig.teams[0].badge_url,
    'https://assets.example.edu/badges/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png',
  );
  assert.deepEqual(result.hubConfig.teams[1].groups, ['本科组', '邀请队']);
  assert.equal(result.hubConfig.teams[1].badge_url, 'http://assets.example.edu/badges/school-b.jpg');
  assert.deepEqual(result.hubConfig.awards, [
    { award_id: 'winner', citation: '冠军', team_ids: ['team-001'] },
    { award_id: 'fight', citation: '顽强拼搏奖', team_ids: ['team-001', 'team-002'] },
    { award_id: 'no-recipient-yet', citation: '待定特别奖', team_ids: [] },
  ]);
});

test('treats present but empty medal and award sheets as unconfigured', () => {
  const sheets = validSheets();
  sheets.奖牌设置 = sheet(MEDAL_HEADERS, []);
  sheets.人工奖项 = sheet(AWARD_HEADERS, []);

  const result = convertWorkbookRows(sheets);
  assert.equal('xcpcio_medals' in result.hubConfig.contest, false);
  assert.equal('awards' in result.hubConfig, false);
});

test('accepts a safe same-origin XCPCIO badge path', () => {
  const sheets = validSheets();
  sheets.学校信息[2] = [...SCHOOL_HEADERS, SCHOOL_BADGE_HEADER];
  sheets.学校信息[3][SCHOOL_HEADERS.length] = '/hydro-league-xcpcio/assets/school-a.png';
  sheets.学校信息[4][SCHOOL_HEADERS.length] = '/hydro-league-xcpcio/assets/%E5%8C%97%E5%AD%97%F0%9F%8F%AB-100%25.png';

  const result = convertWorkbookRows(sheets);
  assert.equal(
    result.hubConfig.teams[0].badge_url,
    '/hydro-league-xcpcio/assets/school-a.png',
  );
  assert.equal(
    result.hubConfig.teams[1].badge_url,
    '/hydro-league-xcpcio/assets/%E5%8C%97%E5%AD%97%F0%9F%8F%AB-100%25.png',
  );
});

test('rejects invalid badge URLs and reserved or duplicate team groups', () => {
  const sheets = validSheets();
  sheets.学校信息[2] = [...SCHOOL_HEADERS, SCHOOL_BADGE_HEADER];
  sheets.学校信息[3][SCHOOL_HEADERS.length] = 'file:///tmp/school-a.png';
  sheets.学校信息[4][SCHOOL_HEADERS.length] = 'https://user:password@example.edu/logo.png';
  sheets.队伍账号映射[2] = [...TEAM_HEADERS, TEAM_GROUPS_HEADER];
  sheets.队伍账号映射[3][TEAM_HEADERS.length] = 'freshman, freshman';
  sheets.队伍账号映射[4][TEAM_HEADERS.length] = 'unofficial';

  assert.throws(
    () => convertWorkbookRows(sheets),
    (error) => error instanceof WorkbookValidationError
      && error.issues.filter((issue) => issue.includes('完整 HTTP(S) URL')).length === 2
      && error.issues.some((issue) => issue.includes('不能包含重复项'))
      && error.issues.some((issue) => issue.includes('保留组 official 或 unofficial')),
  );
});

test('rejects unsafe or out-of-scope root-relative badge paths', () => {
  const invalidPaths = [
    '//hydro-league-xcpcio/assets/logo.png',
    '/other-addon/assets/logo.png',
    '/hydro-league-xcpcio/assets/../logo.png',
    '/hydro-league-xcpcio/assets/%2e%2e/logo.png',
    '/hydro-league-xcpcio/assets/%252e%252e/logo.png',
    '/hydro-league-xcpcio/assets/%25252e%25252e/logo.png',
    '/hydro-league-xcpcio/assets//logo.png',
    '/hydro-league-xcpcio/assets/%2f%2flogo.png',
    '/hydro-league-xcpcio/assets\\logo.png',
    '/hydro-league-xcpcio/assets/line\nbreak.png',
    '/hydro-league-xcpcio/assets/%C2%85control.png',
    '/hydro-league-xcpcio/assets/%E5%8C.png',
    '/hydro-league-xcpcio/assets/%FF.png',
    'https://assets.example.edu/badges/%25252e%25252e/private.png',
    'https://assets.example.edu/badges/%255cprivate.png',
  ];
  for (const badgeUrl of invalidPaths) {
    const sheets = validSheets();
    sheets.学校信息[2] = [...SCHOOL_HEADERS, SCHOOL_BADGE_HEADER];
    sheets.学校信息[3][SCHOOL_HEADERS.length] = badgeUrl;
    assert.throws(
      () => convertWorkbookRows(sheets),
      (error) => error instanceof WorkbookValidationError
        && error.issues.some((issue) => issue.includes('根相对路径')),
      badgeUrl,
    );
  }
});

test('rejects invalid or duplicate medal settings and references to unused groups', () => {
  const sheets = validSheets();
  sheets.队伍账号映射[2] = [...TEAM_HEADERS, TEAM_GROUPS_HEADER];
  sheets.队伍账号映射[3][TEAM_HEADERS.length] = 'freshman';
  sheets.奖牌设置 = sheet(MEDAL_HEADERS, [
    ['freshman', -1, 1.5, ''],
    ['freshman', 1, 2, 3],
    ['missing-group', 0, 0, 0],
  ]);

  assert.throws(
    () => convertWorkbookRows(sheets),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some((issue) => issue.includes('金牌数 必须是'))
      && error.issues.some((issue) => issue.includes('银牌数 必须是'))
      && error.issues.some((issue) => issue.includes('铜牌数 不能为空'))
      && error.issues.some((issue) => issue.includes('奖牌设置分组 重复：freshman'))
      && error.issues.some((issue) => issue.includes('missing-group 未被任何启用队伍使用')),
  );
});

test('rejects duplicate award IDs and awards referencing disabled or unknown teams', () => {
  const sheets = validSheets();
  sheets.队伍账号映射.push([
    'team-003', 'school-a', '停用队', '正式', '', '', 102, 'team003', '', '队员丙', '', '', '', '', '', '', 'A02', '停用',
  ]);
  sheets.人工奖项 = sheet(AWARD_HEADERS, [
    ['winner', '冠军', 'team-003'],
    ['winner', '同ID奖项', 'team-missing'],
  ]);

  assert.throws(
    () => convertWorkbookRows(sheets),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some((issue) => issue.includes('人工奖项ID 重复：winner'))
      && error.issues.some((issue) => issue.includes('不存在或未启用的队伍 team-003'))
      && error.issues.some((issue) => issue.includes('不存在或未启用的队伍 team-missing')),
  );
});

test('rejects an incomplete school by problem mapping matrix', () => {
  const sheets = validSheets();
  sheets.题目映射.pop();
  assert.throws(
    () => convertWorkbookRows(sheets),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some((issue) => issue.includes('乙大学 缺少全局题目 problem-a')),
  );
});

test('rejects mismatched problem packages and duplicate local accounts', () => {
  const sheets = validSheets();
  sheets.题目映射[4][8] = 'c'.repeat(64);
  sheets.队伍账号映射.push([
    'team-003', 'school-a', '重复账号队', '正式', '', '', 101, 'same-user', '', '队员丙', '', '', '', '', '', '', 'A02', '启用',
  ]);
  assert.throws(
    () => convertWorkbookRows(sheets),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some((issue) => issue.includes('学校+Hydro UID'))
      && error.issues.some((issue) => issue.includes('不同学校')),
  );
});

test('rejects a Hydro version outside the beta9 compatibility target', () => {
  const sheets = validSheets();
  sheets.学校信息[3][7] = '5.0.0';
  assert.throws(
    () => convertWorkbookRows(sheets),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some((issue) => issue.includes('5.0.0-beta.9')),
  );
});

test('requires the freeze boundary to be strictly inside the contest interval', () => {
  const sheets = validSheets();
  sheets.联赛配置[3][7] = sheets.联赛配置[3][6];
  assert.throws(
    () => convertWorkbookRows(sheets),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some((issue) => issue.includes('严格位于比赛开始和结束之间')),
  );
});

test('rejects a non-loopback HTTP center unless insecure transport is explicitly enabled', () => {
  assert.throws(
    () => convertWorkbookRows(validSheets(), { centerUrl: 'http://203.0.113.10:3000' }),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some((issue) => issue.includes('必须使用 HTTPS')),
  );
  const result = convertWorkbookRows(validSheets(), {
    centerUrl: 'http://203.0.113.10:3000',
    allowInsecureHttp: true,
  });
  assert.equal(result.siteConfigs['site-a'].allowInsecureHttp, true);
  assert.ok(result.report.warnings.some((warning) => warning.includes('显式允许')));
});
