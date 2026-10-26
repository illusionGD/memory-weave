import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/** 仅输出脚本主动构造的错误说明，避免响应正文、Cookie 或凭据进入日志。 */
class VerificationError extends Error {}

const created = { companions: {}, conversations: {}, messages: [] };
const runLabel = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let baseUrl;
let sessionCookie;
let passed = 0;

/** 只接受明确的 HTTP(S) 站点源，禁止 URL 凭据、查询参数或路径混入验收地址。 */
function configuredBaseUrl() {
  let parsed;
  try {
    parsed = new URL(
      process.env.VERIFY_BASE_URL ?? process.env.APP_ORIGIN ?? 'http://localhost:3000',
    );
  } catch {
    throw new VerificationError('VERIFY_BASE_URL 或 APP_ORIGIN 必须是有效的 HTTP(S) 站点地址。');
  }
  check(
    ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash,
    '验收地址必须是 HTTP(S) 站点源，不能包含账号密码、路径、查询参数或片段。',
  );
  return parsed;
}

/** 断言只使用本地固定说明，不拼接服务端提供的正文。 */
function check(condition, message) {
  if (!condition) throw new VerificationError(message);
}

/** 将已经完成的行为检查输出为可读步骤。 */
function pass(message) {
  passed += 1;
  console.log(`[通过 ${String(passed).padStart(2, '0')}] ${message}`);
}

/**
 * 通过真实 HTTP 调用接口；Cookie 仅保存在进程内，拒绝自动重定向。
 * 每次请求限制十五秒，失败时只报告步骤及状态码，不打印响应正文或底层错误。
 */
async function api(label, path, options = {}) {
  const {
    method = 'GET',
    body,
    authenticated = true,
    status = method === 'POST' ? 201 : 200,
  } = options;
  const statuses = Array.isArray(status) ? status : [status];
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authenticated && sessionCookie) headers.cookie = sessionCookie;
  let response;
  try {
    response = await fetch(new URL(`/api${path}`, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new VerificationError(`${label}：连接失败、发生重定向或请求超时，请检查服务是否启动。`);
  }
  check(
    statuses.includes(response.status),
    `${label}：收到 HTTP ${response.status}，预期 ${statuses.join(' 或 ')}。`,
  );
  if (path === '/auth/login' && response.ok) {
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('memory_weave_session='));
    check(cookie, '登录响应缺少会话 Cookie。');
    sessionCookie = cookie.split(';', 1)[0];
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new VerificationError(`${label}：响应不是有效的 JSON，请检查 API 路由或代理配置。`);
  }
}

/** 记录并立即打印已创建的公开标识，失败中断时也能查到已写入的数据。 */
function remember(kind, label, id) {
  check(typeof id === 'string' && uuidPattern.test(id), `${label}：响应缺少有效 UUID。`);
  if (kind === 'messages') created.messages.push(id);
  else created[kind][label] = id;
  console.log(`  已创建 ${label}：${id}`);
}

/** 查找某伴侣的初始成员关系与权限版本。 */
function membership(detail, companion) {
  const result = detail.members?.find(
    (member) => member.kind === 'companion' && member.companionId === companion.id,
  );
  check(result?.runtimeEpoch === companion.runtimeEpoch, '会话成员缺少正确的伴侣运行代次。');
  check(
    result.permissionVersion === 1 && result.joinedSequence === 1,
    '初始成员范围或权限版本错误。',
  );
  return result;
}

/** 每次写入前读取实际会话版本，避免把草稿保存与发布的版本推进方式写死。 */
async function conversationVersion(conversationId) {
  const detail = await api('读取会话版本', `/conversations/${conversationId}`);
  const version = detail.conversation?.version;
  check(Number.isInteger(version) && version > 0, '会话详情缺少正整数版本。');
  return version;
}

/** 保存验收草稿；保存与发布使用独立幂等键。 */
async function saveDraft(label, conversationId, speaker, text, extra = {}) {
  const request = {
    requestId: randomUUID(),
    speaker,
    expectedConversationVersion: await conversationVersion(conversationId),
    text,
    ...extra,
  };
  const message = await api(label, `/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: request,
  });
  check(
    message.state === 'draft' &&
      message.sequence === null &&
      message.publishedAt === null &&
      message.revision === 1 &&
      message.contentVersion === 1,
    `${label}：保存草稿时错误地分配发布状态、序号或版本。`,
  );
  check(
    message.occurredAt === (request.occurredAt ?? null) &&
      typeof message.receivedAt === 'string' &&
      message.receivedAt.endsWith('Z') &&
      Number.isFinite(Date.parse(message.receivedAt)),
    `${label}：未知发生时间必须为 null，已知时间必须保留，服务器接收时间须独立记录。`,
  );
  remember('messages', label, message.id);
  return { message, request };
}

/** 正式发布已有草稿，并验证内容版本与保存修订号分别变化。 */
async function publishDraft(label, conversationId, draft) {
  const request = {
    requestId: randomUUID(),
    expectedRevision: draft.revision,
    expectedConversationVersion: await conversationVersion(conversationId),
  };
  const message = await api(
    label,
    `/conversations/${conversationId}/messages/${draft.id}/publish`,
    {
      method: 'POST',
      body: request,
    },
  );
  check(
    message.id === draft.id &&
      message.state === 'published' &&
      Number.isInteger(message.sequence) &&
      message.sequence > 0 &&
      message.revision === 2 &&
      message.contentVersion === draft.contentVersion &&
      message.occurredAt === draft.occurredAt &&
      message.receivedAt === draft.receivedAt &&
      typeof message.publishedAt === 'string' &&
      message.publishedAt.endsWith('Z'),
    `${label}：发布后的标识、序号、修订号或内容版本不符合约定。`,
  );
  return { message, request };
}

/** 仅查询伴侣的逐条进度，不进行接收或状态写入。 */
function progress(companion, conversationId) {
  return api(
    '查询实例进度',
    `/companions/${companion.id}/conversations/${conversationId}/progress?runtimeEpoch=${companion.runtimeEpoch}`,
  );
}

/** 读取进度时始终检查整理与交付没有被接收操作误标为完成。 */
function messageProgress(page, messageId) {
  const item = page.items?.find((entry) => entry.messageId === messageId);
  check(item, '实例进度缺少可见已发布消息。');
  check(
    item.processing === 'pending' && item.delivery === 'not_recorded',
    '查询或接收错误地改变了记忆整理或用户交付状态。',
  );
  return item;
}

/** 按实例视角回查确切原文版本；失败状态也通过同一入口检查。 */
function source(companion, message, status = 200, contentVersion = message.contentVersion) {
  return api(
    '按实例视角回查来源',
    `/companions/${companion.id}/sources/${message.id}?runtimeEpoch=${companion.runtimeEpoch}&contentVersion=${contentVersion}`,
    { status },
  );
}

async function main() {
  console.log('F02 验收会通过 HTTP 永久创建专用 A/B/C 实例、私聊、群聊和消息，不会自动删除。');
  console.log('请仅对你准备验收的部署执行；管理者代理的伴侣发言不表示模型生成。');
  baseUrl = configuredBaseUrl();
  check(process.env.ADMIN_PASSWORD, '未设置 ADMIN_PASSWORD，请先在 .env 中配置部署密码。');
  check(
    Number(process.versions.node.split('.')[0]) === 22,
    '请使用项目要求的 Node.js 22 运行验收。',
  );
  console.log(`验收站点：${baseUrl.origin}；本次标记：F02-${runLabel}`);

  await api('未登录访问工作区', '/workspace', { authenticated: false, status: 401 });
  await api('登录管理者', '/auth/login', {
    method: 'POST',
    authenticated: false,
    status: 200,
    body: { password: process.env.ADMIN_PASSWORD },
  });
  const workspace = await api('读取持久工作区', '/workspace');
  check(
    uuidPattern.test(workspace.ownerId) && workspace.schemaVersion === 1,
    '工作区身份结构错误。',
  );
  check(
    (await api('再次读取工作区', '/workspace')).ownerId === workspace.ownerId,
    '工作区 owner 不稳定。',
  );
  pass('未登录被拒绝，登录后可读取稳定的工作区 owner。');

  const companions = {};
  const companionRequests = {};
  for (const label of ['A', 'B', 'C']) {
    const request = {
      requestId: randomUUID(),
      name: `F02-${label}-${runLabel}`,
      initialProfile: `F02 专用验收实例 ${label}；仅用于检查持久化、来源与可见范围。`,
    };
    const companion = await api(`创建实例 ${label}`, '/companions', {
      method: 'POST',
      body: request,
    });
    remember('companions', label, companion.id);
    check(
      companion.ownerId === workspace.ownerId &&
        companion.runtimeEpoch === 1 &&
        companion.initialSnapshot?.sourceKind === 'initial_setting' &&
        companion.initialSnapshot.id !== companion.currentPersonaVersionId &&
        companion.initialSnapshot.profileText === request.initialProfile &&
        companion.currentPersonaVersion?.id === companion.currentPersonaVersionId &&
        companion.currentPersonaVersion.profileText === request.initialProfile,
      `实例 ${label} 未保留独立初始快照与当前人格。`,
    );
    companions[label] = companion;
    companionRequests[label] = request;
  }
  const { A, B, C } = companions;
  check(
    (await api('重试创建实例', '/companions', { method: 'POST', body: companionRequests.A })).id ===
      A.id,
    '相同幂等键创建了重复实例。',
  );
  await api('拒绝创建幂等冲突', '/companions', {
    method: 'POST',
    status: 409,
    body: { ...companionRequests.A, name: `冲突-${runLabel}` },
  });
  await api('拒绝请求指定 owner', '/companions', {
    method: 'POST',
    status: 400,
    body: { ...companionRequests.A, requestId: randomUUID(), ownerId: workspace.ownerId },
  });
  check((await api('读取已创建实例', `/companions/${A.id}`)).id === A.id, '实例详情无法回查。');
  pass('A/B/C 保存独立初始快照和当前人格；创建重试复用，冲突及 owner 注入被拒绝。');

  const definitions = [
    { label: '用户+A私聊', kind: 'private', includeUser: true, participants: [A] },
    { label: '用户+B私聊', kind: 'private', includeUser: true, participants: [B] },
    { label: 'A+B私聊', kind: 'private', includeUser: false, participants: [A, B] },
    { label: '用户+A+B群聊', kind: 'group', includeUser: true, participants: [A, B] },
  ];
  const conversations = {};
  for (const definition of definitions) {
    const request = {
      requestId: randomUUID(),
      kind: definition.kind,
      title: `F02-${definition.label}-${runLabel}`,
      includeUser: definition.includeUser,
      companions: definition.participants.map((companion) => ({
        companionId: companion.id,
        runtimeEpoch: companion.runtimeEpoch,
      })),
    };
    const detail = await api('创建验收会话', '/conversations', { method: 'POST', body: request });
    remember('conversations', definition.label, detail.conversation?.id);
    check(
      detail.conversation.ownerId === workspace.ownerId &&
        detail.members?.length === definition.participants.length + Number(definition.includeUser),
      '会话归属或初始人数不符合请求。',
    );
    for (const companion of definition.participants) membership(detail, companion);
    conversations[definition.label] = detail;
  }
  const privateA = conversations['用户+A私聊'].conversation.id;
  const privateB = conversations['用户+B私聊'].conversation.id;
  const privateAB = conversations['A+B私聊'].conversation.id;
  const group = conversations['用户+A+B群聊'];
  const groupId = group.conversation.id;
  pass('用户+A、用户+B、A+B 私聊及用户+A+B 群聊均保存独立成员范围。');

  const invalidConversation = {
    requestId: randomUUID(),
    kind: 'private',
    title: `F02-无效成员-${runLabel}`,
    includeUser: true,
    companions: [{ companionId: A.id, runtimeEpoch: A.runtimeEpoch + 1 }],
  };
  await api('拒绝错误伴侣代次', '/conversations', {
    method: 'POST',
    body: invalidConversation,
    status: 409,
  });
  await api('拒绝省略伴侣代次', '/conversations', {
    method: 'POST',
    status: 400,
    body: { ...invalidConversation, companions: [{ companionId: A.id }] },
  });
  pass('创建会话必须明确提供当前运行代次。');

  const firstText = `F02 共同原文 ${runLabel}，包含表情 🧵，用于验证 UTF-16 完整正文范围。`;
  const firstDraft = await saveDraft('群聊共同原文草稿', groupId, { kind: 'user' }, firstText);
  check(
    (
      await api('重试保存草稿', `/conversations/${groupId}/messages`, {
        method: 'POST',
        body: firstDraft.request,
      })
    ).id === firstDraft.message.id,
    '保存幂等重试生成了重复草稿。',
  );
  check(
    (await api('管理者读取草稿', `/conversations/${groupId}/messages/${firstDraft.message.id}`))
      .state === 'draft',
    '管理者无法回查草稿。',
  );
  check(
    (await api('查询已发布列表', `/conversations/${groupId}/messages`)).items?.length === 0,
    '草稿出现在已发布列表。',
  );
  check(
    (
      await api(
        '查询伴侣已发布列表',
        `/companions/${A.id}/conversations/${groupId}/messages?runtimeEpoch=1`,
      )
    ).items?.length === 0,
    '伴侣查询泄露草稿。',
  );
  check((await progress(A, groupId)).items?.length === 0, '保存草稿提前登记了待整理项。');
  await source(A, firstDraft.message, 404);
  pass('草稿无发布序号，未知发生时间保留 null，不进入伴侣历史、来源或待整理范围。');

  const firstPublished = await publishDraft('发布群聊共同原文', groupId, firstDraft.message);
  const first = firstPublished.message;
  check(
    first.sequence === 1 && first.sourceKind === 'user_input',
    '首条发布序号或真实输入来源错误。',
  );
  const repeatedPublish = await api(
    '重试发布共同原文',
    `/conversations/${groupId}/messages/${first.id}/publish`,
    {
      method: 'POST',
      body: firstPublished.request,
    },
  );
  check(isDeepStrictEqual(repeatedPublish, first), '发布重试未复用原始发布结果。');
  check(
    (await api('发布后查询列表', `/conversations/${groupId}/messages`)).items?.length === 1,
    '发布重试产生重复原文。',
  );
  pass('正式发布分配唯一序号，修订号变为 2，内容版本不变，发布重试不重复。');

  for (const companion of [A, B]) {
    const page = await api(
      '普通查询共同原文',
      `/companions/${companion.id}/conversations/${groupId}/messages?runtimeEpoch=1`,
    );
    check(page.items?.[0]?.id === first.id, '不同实例未看到同一份原文。');
    check(
      messageProgress(await progress(companion, groupId), first.id).readReceipt === null,
      '普通 GET 写入了实例读取记录。',
    );
  }
  check((await source(A, first)).id === first.id, '有权实例不能回查共同原文。');
  await source(A, first, [404, 409], first.contentVersion + 1);
  pass('A/B 查询同一消息 ID 和内容版本；普通 GET 无已读副作用，错误来源版本被拒绝。');

  const receiveRequest = {
    requestId: randomUUID(),
    runtimeEpoch: A.runtimeEpoch,
    expectedPermissionVersion: membership(group, A).permissionVersion,
    afterSequence: 0,
    limit: 20,
  };
  const receiveAPath = `/companions/${A.id}/conversations/${groupId}/receive`;
  const batchA = await api('实例 A 取得共同原文', receiveAPath, {
    method: 'POST',
    body: receiveRequest,
  });
  check(
    batchA.items?.length === 1 && batchA.items[0].id === first.id,
    'A 接收批次未包含确切原文。',
  );
  const aReceipt = messageProgress(await progress(A, groupId), first.id).readReceipt;
  check(
    aReceipt?.companionId === A.id &&
      aReceipt.messageId === first.id &&
      aReceipt.contentVersion === first.contentVersion &&
      aReceipt.startOffset === 0 &&
      aReceipt.endOffset === firstText.length,
    'A 的独立读取记录缺少确切版本或 UTF-16 完整正文范围。',
  );
  check(
    messageProgress(await progress(B, groupId), first.id).readReceipt === null,
    'A 取得原文错误地推进了 B。',
  );
  pass('A 显式接收后仅 A 已读；B 仍未读，两者仍待整理且未记录用户交付。');

  const staleVersion = (await conversationVersion(groupId)) - 1;
  check(staleVersion > 0, '正式发布没有推进会话版本。');
  await api('拒绝陈旧会话版本', `/conversations/${groupId}/messages`, {
    method: 'POST',
    status: 409,
    body: {
      requestId: randomUUID(),
      speaker: { kind: 'user' },
      text: '不应保存',
      expectedConversationVersion: staleVersion,
    },
  });
  await api('拒绝陈旧接收代次', receiveAPath, {
    method: 'POST',
    status: 409,
    body: { ...receiveRequest, requestId: randomUUID(), runtimeEpoch: A.runtimeEpoch + 1 },
  });
  await api('拒绝陈旧权限版本', receiveAPath, {
    method: 'POST',
    status: 409,
    body: {
      ...receiveRequest,
      requestId: randomUUID(),
      expectedPermissionVersion: receiveRequest.expectedPermissionVersion + 1,
    },
  });
  await api('拒绝省略查询代次', `/companions/${A.id}/conversations/${groupId}/messages`, {
    status: 400,
  });
  pass('陈旧会话版本、接收代次、权限版本被拒绝，查询代次不得省略。');

  const reportedOccurredAt = '2024-01-02T03:04:05.000Z';
  const secondDraft = await saveDraft(
    '管理者代理 A 的转述草稿',
    groupId,
    { kind: 'companion', companionId: A.id, runtimeEpoch: A.runtimeEpoch },
    `F02 管理者代理 A 转述共同原文 ${runLabel}。`,
    {
      occurredAt: reportedOccurredAt,
      epistemicKind: 'report',
      replyToMessageId: first.id,
      sources: [{ messageId: first.id, contentVersion: first.contentVersion, relation: 'report' }],
    },
  );
  check(
    secondDraft.message.sourceKind === 'admin_companion_input',
    '管理者代理伴侣发言未明确标记来源。',
  );
  check(
    secondDraft.message.receivedAt !== reportedOccurredAt,
    '给定的历史发生时间错误地替代了服务器接收时间。',
  );
  await api(
    '拒绝错误消息修订号',
    `/conversations/${groupId}/messages/${secondDraft.message.id}/publish`,
    {
      method: 'POST',
      status: 409,
      body: {
        requestId: randomUUID(),
        expectedRevision: secondDraft.message.revision + 1,
        expectedConversationVersion: await conversationVersion(groupId),
      },
    },
  );
  const second = (await publishDraft('发布管理者代理 A 的转述', groupId, secondDraft.message))
    .message;
  check(second.sequence === first.sequence + 1, '第二条正式消息序号不连续。');
  const sourcedSecond = await source(B, second);
  check(
    sourcedSecond.sources?.[0]?.messageId === first.id &&
      sourcedSecond.occurredAt === reportedOccurredAt,
    '转述原文丢失稳定来源引用或给定发生时间。',
  );
  pass('代理输入保留管理来源、原文引用和已知发生时间，错误修订号不能发布。');

  const repeatedBatch = await api('新增消息后重试 A 原接收批次', receiveAPath, {
    method: 'POST',
    body: receiveRequest,
  });
  check(isDeepStrictEqual(repeatedBatch, batchA), '接收幂等重试因新增消息改变了原始批次。');
  check(
    messageProgress(await progress(A, groupId), second.id).readReceipt === null,
    '重试原批次错误地读到了新增消息。',
  );
  await api('拒绝接收幂等载荷冲突', receiveAPath, {
    method: 'POST',
    status: 409,
    body: { ...receiveRequest, limit: 2 },
  });
  pass('新增原文后重试仍返回原接收批次，原读取时间及消息集合不变，异载荷被拒绝。');

  const batchB = await api(
    '实例 B 独立取得共同原文',
    `/companions/${B.id}/conversations/${groupId}/receive`,
    {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        runtimeEpoch: B.runtimeEpoch,
        expectedPermissionVersion: membership(group, B).permissionVersion,
      },
    },
  );
  check(
    batchB.items?.some(
      (message) => message.id === first.id && message.contentVersion === first.contentVersion,
    ),
    'B 接收未复用共同原文版本。',
  );
  const bReceipt = messageProgress(await progress(B, groupId), first.id).readReceipt;
  check(
    bReceipt?.companionId === B.id && bReceipt.id !== aReceipt.id,
    'B 没有建立独立于 A 的读取记录。',
  );
  pass('B 随后独立接收同一原文版本，读取记录与 A 分离。');

  const privateMessages = [];
  for (const [label, conversationId, speaker] of [
    ['用户+A私聊原文', privateA, { kind: 'user' }],
    ['用户+B私聊原文', privateB, { kind: 'user' }],
    [
      'A+B私聊原文',
      privateAB,
      { kind: 'companion', companionId: B.id, runtimeEpoch: B.runtimeEpoch },
    ],
  ]) {
    const draft = await saveDraft(label, conversationId, speaker, `F02 ${label} ${runLabel}。`);
    privateMessages.push(
      (await publishDraft(`发布${label}`, conversationId, draft.message)).message,
    );
  }
  await source(A, privateMessages[0]);
  await source(B, privateMessages[1]);
  await source(A, privateMessages[1], 404);
  await source(B, privateMessages[0], 404);
  for (const message of privateMessages) await source(C, message, 404);
  await source(C, first, 404);
  await api(
    '拒绝非成员 C 查询私聊',
    `/companions/${C.id}/conversations/${privateA}/messages?runtimeEpoch=1`,
    { status: 404 },
  );
  await api('拒绝非成员 C 接收私聊', `/companions/${C.id}/conversations/${privateA}/receive`, {
    method: 'POST',
    status: 404,
    body: { requestId: randomUUID(), runtimeEpoch: C.runtimeEpoch, expectedPermissionVersion: 1 },
  });
  await api(
    '拒绝通过群聊身份读取他人私聊',
    `/companions/${A.id}/conversations/${privateB}/messages?runtimeEpoch=1`,
    { status: 404 },
  );
  pass('C 不能读取或接收非成员私聊及来源；A/B 的共同会话身份不扩大各自其他私聊范围。');

  await api('拒绝跨会话引用私聊原文', `/conversations/${groupId}/messages`, {
    method: 'POST',
    status: 404,
    body: {
      requestId: randomUUID(),
      speaker: { kind: 'companion', companionId: A.id, runtimeEpoch: A.runtimeEpoch },
      expectedConversationVersion: await conversationVersion(groupId),
      text: '不应通过引用扩大私聊可见范围。',
      sources: [
        {
          messageId: privateMessages[1].id,
          contentVersion: privateMessages[1].contentVersion,
          relation: 'reference',
        },
      ],
    },
  });
  pass('来源引用不能绕过会话边界或暴露其他私聊原文。');
  console.log(`F02 HTTP 验收完成：${passed} 个步骤通过。数据已保留，可按以下公开标识回查：`);
  console.log(JSON.stringify(created, null, 2));
}

try {
  await main();
} catch (error) {
  const explanation =
    error instanceof VerificationError
      ? error.message
      : '遇到未预期的响应结构，已停止；请检查服务日志。';
  console.error(`F02 验收失败：${explanation}`);
  if (Object.keys(created.companions).length > 0) {
    console.error('此前已经创建的数据仍会保留，公开标识如下：');
    console.error(JSON.stringify(created, null, 2));
  }
  process.exitCode = 1;
} finally {
  if (sessionCookie && baseUrl) {
    try {
      await api('结束验收会话', '/auth/logout', { method: 'POST', status: 204 });
    } catch {
      console.error('未能撤销本次验收登录会话；Cookie 未写入文件，服务端会话按原有期限过期。');
    }
    sessionCookie = undefined;
  }
}
