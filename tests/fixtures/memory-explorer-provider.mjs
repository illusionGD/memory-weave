import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/** 固定中文验收语料的外部模型替身，只验证协议和界面，不评价真实提取质量。 */
export function createMemoryExplorerProvider() {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health') {
      response.end('{"ready":true}');
      return;
    }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 100000) throw new Error('too large');
      }
      const payload = JSON.parse(body);
      if (payload.model !== 'memory-explorer-fixture') throw new Error('unknown model');
      const input = JSON.parse(
        payload.messages.findLast((message) => message.role === 'user').content,
      );
      const actions = [];
      for (const message of input.messages.filter((message) => message.target)) {
        const scenario = scenarioFor(message.text);
        if (!scenario) continue;
        const previous = scenario.revision
          ? input.related.find(
              (item) => item.document?.claim === 'fact' && /住/.test(item.document.text),
            )
          : null;
        if (scenario.revision && !previous) throw new Error('missing prior memory');
        actions.push({
          action: scenario.revision ? 'revise' : 'add',
          targetId: previous?.id ?? null,
          targetVersion: previous?.version ?? null,
          revisionKind: scenario.revision ?? null,
          document: scenario.document,
          reason: '固定验收语料；只用于验证版本、来源和界面。',
          evidence: [
            {
              messageId: message.messageId,
              contentVersion: message.contentVersion,
              quote: message.text,
            },
          ],
        });
      }
      response.end(
        JSON.stringify({
          model: payload.model,
          choices: [{ message: { content: JSON.stringify({ actions }) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 60, completion_tokens: 120 },
        }),
      );
    } catch {
      response.statusCode = 400;
      response.end('{"error":"invalid fixture input"}');
    }
  });
}
/** 期望来自固定场景，不根据待测查询结果反推。 */
function scenarioFor(text) {
  const document = {
    kind: 'semantic',
    claim: 'fact',
    subject: { kind: 'user', name: null },
    text: '',
    reality: 'real',
    storyKey: null,
    epistemic: 'statement',
    eventTime: null,
    validFrom: null,
    validUntil: null,
  };
  if (text === '我住杭州。') return { document: { ...document, text: '用户住杭州。' } };
  if (text === '昨天搬到苏州了。')
    return {
      revision: 'change',
      document: { ...document, text: '用户住苏州。', eventTime: '昨天', validFrom: '昨天' },
    };
  if (text === '刚才说错了，其实住南京。')
    return { revision: 'correction', document: { ...document, text: '用户住南京。' } };
  if (text === '也许我更喜欢雨天。')
    return {
      document: {
        ...document,
        claim: 'preference',
        text: '用户可能更喜欢雨天。',
        epistemic: 'inference',
      },
    };
  if (text === '故事《月之旅》的主角住在月亮。')
    return {
      document: {
        ...document,
        kind: 'narrative',
        claim: 'creative_setting',
        text: '故事主角住在月亮。',
        subject: { kind: 'other', name: '故事主角' },
        reality: 'fictional',
        storyKey: '月之旅',
        epistemic: 'setting',
      },
    };
  return null;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createMemoryExplorerProvider();
  server.listen(4185, '127.0.0.1');
  process.on('SIGTERM', () => {
    server.closeAllConnections();
    server.close();
  });
}
