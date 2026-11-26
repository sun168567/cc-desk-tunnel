import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createI18n, phrase, wordsText } from '@cc-desk-tunnel/i18n';
import { textOf } from '../src/errors.ts';

// Each message of the service that is filled in, against the text the service wrote itself before it sent phrases
// (the template it had, with the same values): in Chinese the words are the same.
const said: [ReturnType<typeof phrase>, string][] = [
  [
    phrase('service:connection.versionMismatch', { version: '0.3.21' }),
    `客户端与服务端（${'0.3.21'}）的版本不一致，需要升级其中一方。`,
  ],
  [
    phrase('service:connection.sshFailedSaid', { said: phrase('service:probe.noAnswer') }),
    `隧道已建立，但本机 SSH 服务没有执行探测命令。${`\n本机答复：${'20 秒内没有应答。'}`}`,
  ],
  [
    phrase('service:connection.sshFailedSaid', { said: 'Permission denied' }),
    `隧道已建立，但本机 SSH 服务没有执行探测命令。\n本机答复：Permission denied`,
  ],
  [phrase('service:connection.sshFailed'), `隧道已建立，但本机 SSH 服务没有执行探测命令。${''}`],
  [phrase('service:probe.noOutputCode', { code: '255' }), `没有输出${`（退出代码 ${255}）`}。`],
  [phrase('service:probe.noOutput'), `没有输出${''}。`],
  [
    phrase('service:device.otherOffline', { name: '笔记本' }),
    `设备“${'笔记本'}”不在线。它连上服务后才能在这里操作它的会话；也可以把会话接到本机或分叉到本机。`,
  ],
  [
    phrase('service:device.otherNotReady', { name: '笔记本' }),
    `设备“${'笔记本'}”的执行通道尚未就绪，请稍候再试。`,
  ],
  [
    phrase('service:capacity', { count: 4 }),
    `服务端同时最多进行 ${4} 个运行或终端（按服务器内存估算，可用 PROXY_MAX_RUNS 调整）。请等其他任务结束后再试。`,
  ],
  [
    phrase('service:account.tokenSaveFailed', { detail: 'EACCES' }),
    `无法保存 setup token：${'EACCES'}`,
  ],
  [phrase('service:account.logoutFailed', { detail: 'EACCES' }), `退出登录失败：${'EACCES'}`],
  [phrase('service:account.logoutExit', { code: '1' }), `claude auth logout 退出码：${1}`],
  [
    phrase('service:account.loginExit', { code: '2' }),
    `官方登录命令异常退出（退出码 ${2}），未提供错误输出。`,
  ],
  [phrase('service:account.noToken', { count: 30 }), `${30} 秒未拿到令牌，请重新生成链接。${''}`],
  [
    phrase('service:account.noTokenSaid', { count: 30, said: 'Creating token…' }),
    `${30} 秒未拿到令牌，请重新生成链接。${`（官方命令：${'Creating token…'}）`}`,
  ],
  [
    phrase('service:account.tokenNotSaved', { detail: 'EACCES' }),
    `令牌已生成但无法保存：${'EACCES'}`,
  ],
  [
    phrase('service:instructions.tooLong', { count: 64000 }),
    `全局说明超过 ${64000} 字，请在 ccdt 里用 /memory 编辑。`,
  ],
  [
    phrase('service:stopped.offline', { count: 90 }),
    `设备离线超过 ${90} 秒，运行已停止；在途命令结果可能未知。`,
  ],
  [
    phrase('service:notice.cacheExpiring', { count: 55 }),
    `上一轮结束已 ${55} 分钟，提示缓存即将过期：按设置自动压缩上下文，压缩读取的是缓存。`,
  ],
  [
    phrase('service:notice.loginExpiring', { count: 5, date: '2026-11-15' }),
    `Claude Code 的登录约 ${5} 天后到期（${'2026-11-15'}），到期后要在“账号与额度”里重新登录。`,
  ],
  [
    phrase('service:notice.loginExpired', { date: '2026-11-09' }),
    `Claude Code 的登录可能已经到期（${'2026-11-09'}）；如果请求开始失败，请在“账号与额度”里重新登录。`,
  ],
  [
    phrase('service:notice.modeMismatch', {
      requested: 'plan',
      reported: phrase('service:notice.modeUnknown'),
    }),
    `请求审批模式 ${'plan'}；原生进程实际报告 ${'未知'}。`,
  ],
  [
    phrase('service:notice.writesLost', {
      disk: phrase('service:notice.diskQuota'),
      lost: [phrase('service:notice.lostTranscript'), phrase('service:notice.lostConfig')],
    }),
    `${'服务器的磁盘配额已用完'}，Claude Code 有内容没能保存：${[
      '会话记录缺了一部分，之后继续这个会话时 Claude 可能看不到这段对话',
      '它自己的配置（~/.claude.json）的改动',
    ].join('；')}。请清理服务器磁盘。`,
  ],
  [
    phrase('service:notice.terminalCommand', { command: '/model' }),
    `在终端里执行了 ${'/model'}${''}`,
  ],
  [
    phrase('service:notice.terminalCommandOutput', { command: '/model', output: 'Set model' }),
    `在终端里执行了 ${'/model'}${`：${'Set model'}`}`,
  ],
  [
    phrase('service:update.held', {
      reasons: [
        phrase('service:update.running', { titles: ['甲'], count: 1 }),
        phrase('service:update.mutating'),
        phrase('service:update.signingIn'),
      ],
    }),
    `${['「甲」正在运行', '有会话正在移动或修改', 'Claude 账号正在登录'].join('，')}。升级会重启服务端并中断它们：等结束后再升级，或选择强行升级。`,
  ],
  [
    phrase('service:update.running', { titles: ['甲', '乙'], count: 2 }),
    `${['甲', '乙'].map((title) => `「${title}」`).join('')}正在运行`,
  ],
  [
    phrase('service:update.runningMany', { titles: ['甲', '乙', '丙'], count: 4 }),
    `${['甲', '乙', '丙'].map((title) => `「${title}」`).join('') + ` 等 ${4} 个会话`}正在运行`,
  ],
  [
    phrase('service:update.releasesUnreachable', { status: 404 }),
    `发布页无法访问（${404}）；跟踪私有仓库时需要在服务端配置只读令牌。`,
  ],
  [phrase('service:update.releasesFailed', { status: 502 }), `发布页请求失败（${502}）。`],
  [phrase('service:update.missingFile', { name: 'a.tar.gz' }), `发布中缺少 ${'a.tar.gz'}。`],
  [
    phrase('service:update.downloadBroken', {
      name: 'a.tar.gz',
      reason: phrase('service:update.noData'),
    }),
    `${'a.tar.gz'} 下载中断：${'连接没有数据'}。`,
  ],
  [phrase('service:update.tooLarge', { name: 'a.tar.gz' }), `${'a.tar.gz'} 比发布清单里的大。`],
  [phrase('service:update.checksum', { name: 'a.tar.gz' }), `${'a.tar.gz'} 校验失败。`],
  [
    phrase('service:update.installingClaude', { version: '2.1.300' }),
    `安装 Claude Code ${'2.1.300'}`,
  ],
  [
    phrase('service:update.notFinished', { version: '0.3.20', reason: 'npm ERR!' }),
    `升级没有完成，仍在运行 ${'0.3.20'}：${'npm ERR!'}`,
  ],
  // Plugins came with phrases: what they say is said here as it reads.
  [
    phrase('service:plugins.broken', { file: 'hooks/hooks.json', reason: 'Unexpected token' }),
    'hooks/hooks.json 有误：Unexpected token',
  ],
  [phrase('service:plugins.unset', { titles: ['令牌', '地址'] }), '要先设置：「令牌」「地址」'],
  [phrase('service:plugins.option.unknown', { key: 'colour' }), '这个插件没有设置项 colour。'],
  [phrase('service:plugins.option.string', { title: '地址' }), '“地址”应是文字。'],
  [phrase('service:plugins.option.number', { title: '次数' }), '“次数”应是数字。'],
  [phrase('service:plugins.option.boolean', { title: '开关' }), '“开关”应是开或关。'],
  [phrase('service:plugins.option.choice', { title: '格式' }), '“格式”只能选列出的值。'],
  [
    phrase('service:plugins.option.choiceOfString', { title: '次数' }),
    '“次数”不是文字，不能列出可选的值。',
  ],
  [phrase('service:plugins.option.min', { title: '次数', min: 0 }), '“次数”不能小于 0。'],
  [phrase('service:plugins.option.max', { title: '次数', max: 1000 }), '“次数”不能大于 1,000。'],
];

test('in Chinese the service says what it said before it sent phrases', () => {
  for (const [words, before] of said) assert.equal(textOf(words), before, words.key);
});

test('every message the service fills in is in the list above', async () => {
  const { catalogs } = await import('../../../packages/i18n/src/catalogs.ts');
  const flat = (tree: object, prefix = ''): [string, string][] =>
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string'
        ? [[prefix + key, value] as [string, string]]
        : flat(value, `${prefix}${key}.`),
    );
  const filled = flat(catalogs['zh-CN'].service)
    .filter(([, text]) => text.includes('{{'))
    .map(([key]) => `service:${key.replace(/_other$/, '')}`);
  const listed = new Set(said.map(([words]) => words.key));
  assert.deepEqual(
    filled.filter((key) => !listed.has(key)),
    [],
  );
});

test('a phrase is said in English too, with its plural and lists', () => {
  const en = createI18n('en');
  assert.equal(
    wordsText(
      en.t,
      phrase('service:update.held', {
        reasons: [
          phrase('service:update.running', { titles: ['A', 'B'], count: 2 }),
          phrase('service:update.signingIn'),
        ],
      }),
    ),
    '“A” and “B” are running; the Claude account is signing in. Upgrading restarts the server and interrupts them: upgrade when they are done, or force the upgrade.',
  );
  assert.equal(
    wordsText(en.t, phrase('service:stopped.offline', { count: 1 })),
    'The computer was offline for more than 1 second, so the run was stopped. Commands under way may or may not have finished.',
  );
  // A phrase of a message this version does not know is shown by the text sent with it.
  assert.equal(wordsText(en.t, { key: 'service:later.thing' }, '后来的话'), '后来的话');
});
