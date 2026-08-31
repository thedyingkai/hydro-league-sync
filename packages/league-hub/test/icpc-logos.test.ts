import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import {
  buildCdpZip,
  buildContestApiResources,
  buildEventFeed,
  HubDatabase,
} from '../src/index.js';
import type { ScoreboardSnapshot } from '../src/scoreboard.js';

const badgeCases = [
  {
    schoolId: 'school-besti',
    filename: 'besti.png',
    variants: [
      { size: 56, md5: '5de2f548403cbc580aec4bdd5aa56c22', sha256: '945ec82d350bb776d2bf90f2337777be628e0fc876e8a07ab1fe404eb0dfaf4f' },
      { size: 160, md5: '111c68108cbd8644f829945298632437', sha256: '67ef3ce5cdd97ff80464fe2c3599ac0c37cff41466e1b5da6dcc2ccdcd384f63' },
    ],
  },
  {
    schoolId: 'school-buct',
    filename: 'buct.jpg',
    variants: [
      { size: 56, md5: '796155352b761e7f0c5b6275b0101c80', sha256: '48cbbf64d819b1ffadd2c6825b2bb256ad171423f6b5fe9e94a8276efa13f50d' },
      { size: 160, md5: '0f16ea88c8c11ba1826c2e77f99c5734', sha256: 'ab3c3a85b2d0c30aa36876d2dda0e0b0bbd1243c2380c733fbcc40894116df0e' },
    ],
  },
  {
    schoolId: 'school-muc',
    filename: 'muc.png',
    variants: [
      { size: 56, md5: '22d248cf874577dc71531e69e9f447a1', sha256: 'bdd0e2c01f22cec440c51c734bb540fc96072e9702a76b2ffec529635c51a6cf' },
      { size: 160, md5: '464264faeeaccb1449e4ef07bf2a9003', sha256: '5e4969b9dab2011d084a45a989afb925fb613f85048ddbe448a94642fc2af79a' },
    ],
  },
] as const;

function setup(): { database: HubDatabase; snapshot: ScoreboardSnapshot } {
  const database = new HubDatabase(':memory:');
  database.importConfiguration({
    contest: {
      contest_id: 'league-logo-test',
      name: 'Logo export test',
      start_time: '2026-08-30T02:00:00.000Z',
      end_time: '2026-08-30T07:00:00.000Z',
      penalty_minutes: 20,
    },
    sites: [],
    teams: [
      ...badgeCases.map((badge) => ({
        team_id: `team-${badge.filename}`,
        name: badge.schoolId,
        school_id: badge.schoolId,
        school_name: badge.schoolId,
        badge_url: `/hydro-league-xcpcio/school-badges/${badge.filename}`,
      })),
      {
        team_id: 'team-remote',
        name: 'Remote badge team',
        school_id: 'school-remote',
        school_name: 'Remote school',
        badge_url: 'https://assets.example.test/hydro-league-xcpcio/school-badges/besti.png',
      },
      {
        team_id: 'team-missing',
        name: 'Missing badge team',
        school_id: 'school-missing',
        school_name: 'Missing school',
        badge_url: '/hydro-league-xcpcio/school-badges/missing.png',
      },
    ],
    problems: [{ problem_id: 'problem-a', label: 'A', name: 'Alpha', ordinal: 0 }],
    team_mappings: [],
    problem_mappings: [],
  }, '2026-08-30T01:00:00.000Z');
  const contest = database.getContest();
  assert.ok(contest);
  return {
    database,
    snapshot: {
      contest,
      view: 'jury',
      generated_at: '2026-08-30T07:30:00.000Z',
      cursor: 0,
      frozen: false,
      freeze_time: null,
      accuracy: { complete: true, message: null, affected_sites: [] },
      sites: [],
      problems: database.getProblems(),
      rows: [],
    },
  };
}

test('organization logos are synchronized and bundled into Resolver CDP paths', (t) => {
  const { database, snapshot } = setup();
  t.after(() => database.close());

  const resources = buildContestApiResources(database, snapshot);
  const organizations = new Map(resources.organizations.map((item) => [String(item.id), item]));
  for (const badge of badgeCases) {
    const stem = badge.filename.replace(/\.[^.]+$/u, '');
    assert.deepEqual(organizations.get(badge.schoolId)?.logo, badge.variants.map((variant) => ({
      href: `/hydro-league-xcpcio/school-badges/${stem}.${variant.size}x${variant.size}.png`,
      filename: `${stem}.${variant.size}x${variant.size}.png`,
      mime: 'image/png',
      hash: variant.md5,
      width: variant.size,
      height: variant.size,
    })));
  }
  assert.equal(organizations.get('school-remote')?.logo, undefined);
  assert.equal(organizations.get('school-missing')?.logo, undefined);

  const notifications = buildEventFeed(database, snapshot, true);
  const organizationEvents = new Map(notifications
    .filter((item) => item.type === 'organizations')
    .map((item) => [String(item.id), item.data]));
  for (const [id, organization] of organizations) {
    assert.deepEqual(organizationEvents.get(id), organization);
  }

  const files = unzipSync(buildCdpZip(database, snapshot));
  assert.deepEqual(JSON.parse(strFromU8(files['organizations.json']!)), resources.organizations);
  for (const badge of badgeCases) {
    const stem = badge.filename.replace(/\.[^.]+$/u, '');
    for (const variant of badge.variants) {
      const variantFilename = `${stem}.${variant.size}x${variant.size}.png`;
      const archivePath = `organizations/${badge.schoolId}/${variantFilename}`;
      const bytes = files[archivePath];
      assert.ok(bytes, `CDP contains ${archivePath}`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), variant.sha256);
    }
    assert.equal(files[`organizations/${badge.schoolId}/${badge.filename}`], undefined);
  }
  assert.equal(
    files['organizations/school-remote/besti.png'],
    undefined,
    'an absolute URL with a bundled-looking pathname is not read from local disk',
  );
  assert.deepEqual(
    Object.keys(files).filter((name) => name.startsWith('organizations/school-remote/')),
    [],
  );
  assert.deepEqual(
    Object.keys(files).filter((name) => name.startsWith('organizations/school-missing/')),
    [],
  );
  const feed = strFromU8(files['event-feed.ndjson']!).trim().split('\n').map((line) => JSON.parse(line));
  const cdpOrganizationEvents = new Map(feed
    .filter((item) => item.type === 'organizations')
    .map((item) => [String(item.id), item.data]));
  for (const [id, organization] of organizations) {
    assert.deepEqual(cdpOrganizationEvents.get(id), organization);
  }
});
