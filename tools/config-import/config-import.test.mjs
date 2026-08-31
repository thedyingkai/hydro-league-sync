import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONFIG_HEADERS,
  PROBLEM_HEADERS,
  SCHOOL_HEADERS,
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
