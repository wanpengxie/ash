import test from 'node:test';
import assert from 'node:assert/strict';
import { createTitle } from '../js/desktop-create.js';
import { parseCreateWorkRequest } from '../../device/src/collaboration/create-protocol.ts';
test('automatic create title uses the first nonempty sentence/line and preserves Unicode within the wire byte limit', () => {
  assert.equal(createTitle('\n\t\n总结项目。然后检查测试\n下一行'), '总结项目。');
  assert.equal(createTitle('First request! Follow-up'), 'First request!');
  for (const input of ['😀'.repeat(100), '汉'.repeat(100), '\u0000\u0001标题\u007f\n原始要求']) {
    const title=createTitle(input); assert.ok(title); assert.ok(new TextEncoder().encode(title).length<=256); assert.equal(/[\u0000-\u001f\u007f-\u009f\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(title),false);
    assert.equal(parseCreateWorkRequest({version:1,request_id:'request',operation_id:'operation',authorization_revision:'a'.repeat(64),target:{node_id:'node',endpoint_id:'node',project_id:'project',cwd:'/project'},title,input:{text:input},expires_at:1000}).title,title);
  }
  assert.equal(createTitle('\n\u0000\u007f'), '');
});
