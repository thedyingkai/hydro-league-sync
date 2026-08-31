#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readWorkbook from 'read-excel-file/node';
import {
  OPTIONAL_SHEETS,
  REQUIRED_SHEETS,
  WorkbookValidationError,
  convertWorkbookRows,
} from './config-import.mjs';

function usage() {
  return [
    '用法：npm run import:config -- <参赛信息.xlsx> [私密输出目录] [中心地址] [--allow-insecure-http]',
    '',
    '默认输出：private-config/<Excel文件名>/',
    '默认中心：http://127.0.0.1:3000',
  ].join('\n');
}

function parseArguments(argv) {
  let workbookPath;
  let outputDirectory;
  let centerUrl = 'http://127.0.0.1:3000';
  let centerUrlExplicit = false;
  let allowInsecureHttp = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--out=')) {
      outputDirectory = argument.slice('--out='.length);
    } else if (argument.startsWith('--center-url=')) {
      centerUrl = argument.slice('--center-url='.length);
      centerUrlExplicit = true;
    } else if (argument === '--out') {
      outputDirectory = argv[++index];
    } else if (argument === '--center-url') {
      centerUrl = argv[++index];
      centerUrlExplicit = true;
    } else if (argument === '--allow-insecure-http') {
      allowInsecureHttp = true;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else if (argument.startsWith('-')) {
      throw new Error(`未知参数：${argument}`);
    } else if (!workbookPath) {
      workbookPath = argument;
    } else if (!outputDirectory) {
      outputDirectory = argument;
    } else if (!centerUrlExplicit) {
      centerUrl = argument;
      centerUrlExplicit = true;
    } else {
      throw new Error(`多余参数：${argument}`);
    }
  }
  if (!workbookPath) throw new Error('缺少 Excel 文件路径');
  if (outputDirectory === undefined && argv.includes('--out')) throw new Error('--out 缺少目录');
  if (!centerUrl) throw new Error('--center-url 缺少地址');
  if (!outputDirectory) {
    const basename = path.basename(workbookPath, path.extname(workbookPath));
    outputDirectory = path.join('private-config', basename);
  }
  return { help: false, workbookPath, outputDirectory, centerUrl, allowInsecureHttp };
}

async function readExistingSecrets(outputDirectory) {
  const filename = path.join(outputDirectory, 'site-secrets.json');
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`无法读取已有密钥文件 ${filename}：${error.message}`);
  }
}

async function writeJson(filename, value) {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function dotenv(environment) {
  return `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
}

async function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }

  const workbookPath = path.resolve(args.workbookPath);
  if (path.extname(workbookPath).toLowerCase() !== '.xlsx') {
    throw new Error('只接受 .xlsx 文件；旧版 .xls 必须先由 Excel 另存为 .xlsx');
  }
  const outputDirectory = path.resolve(args.outputDirectory);
  const workbook = await readWorkbook(workbookPath);
  const availableSheets = workbook.map((entry) => entry.sheet);
  const missing = REQUIRED_SHEETS.filter((sheet) => !availableSheets.includes(sheet));
  if (missing.length) throw new WorkbookValidationError(missing.map((sheet) => `缺少工作表“${sheet}”`));

  const importedSheets = new Set([...REQUIRED_SHEETS, ...OPTIONAL_SHEETS]);
  const sheets = Object.fromEntries(
    workbook.filter((entry) => importedSheets.has(entry.sheet))
      .map((entry) => [entry.sheet, entry.data]),
  );
  await mkdir(outputDirectory, { recursive: true });
  const existingSecrets = await readExistingSecrets(outputDirectory);
  const converted = convertWorkbookRows(sheets, {
    centerUrl: args.centerUrl,
    allowInsecureHttp: args.allowInsecureHttp,
    secrets: existingSecrets,
  });

  await writeJson(path.join(outputDirectory, 'hub-config.json'), converted.hubConfig);
  await writeJson(path.join(outputDirectory, 'site-secrets.json'), converted.secrets);
  await writeFile(path.join(outputDirectory, '.env.hub'), dotenv(converted.environment), {
    encoding: 'utf8',
    mode: 0o600,
  });
  const siteDirectory = path.join(outputDirectory, 'site-configs');
  await mkdir(siteDirectory, { recursive: true });
  for (const [siteId, config] of Object.entries(converted.siteConfigs)) {
    await writeJson(path.join(siteDirectory, `${siteId}.json`), config);
  }
  const report = {
    generated_at: new Date().toISOString(),
    source_workbook: workbookPath,
    output_directory: outputDirectory,
    ...converted.report,
  };
  await writeJson(path.join(outputDirectory, 'import-report.json'), report);

  console.log(`Excel 校验通过：${report.school_count} 所学校，${report.active_team_count} 支启用队伍，${report.problem_count} 道题。`);
  console.log(`私密部署配置已写入：${outputDirectory}`);
  console.log('密钥已复用或生成，但不会打印到终端；请勿把该目录提交到 Git。');
  for (const warning of report.warnings) console.warn(`警告：${warning}`);
}

main().catch((error) => {
  if (error instanceof WorkbookValidationError) {
    console.error(error.message);
    error.issues.forEach((issue) => console.error(`- ${issue}`));
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
