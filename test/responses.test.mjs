/**
 * Responses API 兼容层。
 *
 * Codex 走 wire_api = "responses" 时发的是 input 而不是 messages，
 * magpie 会原样把请求转到插件。这些测试锁定「折成 chat 形状」这一步，
 * 以及回程「折成 response 对象」的形状。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { responsesToChat, chatToResponses, responsesEventStreamFromMessage } from '../lib/responses.mjs'
import { estimateTokens } from '../lib/chat.mjs'

test('input 是字符串时折成一条 user 消息', () => {
  const chat = responsesToChat({ model: 'm', input: '你好' })
  assert.deepEqual(chat.messages, [{ role: 'user', content: '你好' }])
})

test('instructions 排在最前，当作 system', () => {
  const chat = responsesToChat({ model: 'm', instructions: '你是助手', input: '你好' })
  assert.equal(chat.messages[0].role, 'system')
  assert.equal(chat.messages[0].content, '你是助手')
  assert.equal(chat.messages[1].content, '你好')
})

test('content 数组折成纯文本，图片类型的段跳过', () => {
  const chat = responsesToChat({
    model: 'm',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: '看图' },
        { type: 'input_image', image_url: 'https://x/y.png' },
      ],
    }],
  })
  assert.equal(chat.messages[0].content, '看图')
})

test('function_call 并进 assistant.tool_calls', () => {
  const chat = responsesToChat({
    model: 'm',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列目录' }] },
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
    ],
  })
  const assistant = chat.messages.find((m) => m.role === 'assistant')
  assert.equal(assistant.tool_calls[0].id, 'call_1')
  assert.equal(assistant.tool_calls[0].function.name, 'shell')
  const tool = chat.messages.find((m) => m.role === 'tool')
  assert.equal(tool.tool_call_id, 'call_1')
  assert.equal(tool.content, 'a.txt')
})

test('扁平的 tools 折成 chat 的嵌套结构', () => {
  const chat = responsesToChat({
    model: 'm',
    input: 'hi',
    tools: [{ type: 'function', name: 'shell', description: 'd', parameters: { type: 'object' } }],
  })
  assert.equal(chat.tools[0].function.name, 'shell')
  assert.equal(chat.tools[0].function.description, 'd')
})

test('max_output_tokens 换成 max_tokens，input/instructions 不留残余', () => {
  const chat = responsesToChat({ model: 'm', input: 'hi', instructions: 'x', max_output_tokens: 4096 })
  assert.equal(chat.max_tokens, 4096)
  assert.equal('max_output_tokens' in chat, false)
  assert.equal('input' in chat, false)
  assert.equal('instructions' in chat, false)
})

test('chat 结果折回 response 对象，usage 用 input/output_tokens', () => {
  const completion = {
    id: 'chatcmpl-1',
    created: 1700000000,
    model: 'doubao-glm-5-3',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }
  const resp = chatToResponses(completion, 'doubao-glm-5-3')
  assert.equal(resp.object, 'response')
  assert.equal(resp.status, 'completed')
  assert.equal(resp.output[0].type, 'message')
  assert.equal(resp.output[0].content[0].text, '你好')
  assert.equal(resp.usage.input_tokens, 12)
  assert.equal(resp.usage.output_tokens, 3)
})

test('工具调用折回 function_call item', () => {
  const completion = {
    id: 'c', created: 1, model: 'm',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }
  const resp = chatToResponses(completion, 'm')
  const call = resp.output.find((x) => x.type === 'function_call')
  assert.equal(call.call_id, 'call_1')
  assert.equal(call.name, 'shell')
  assert.equal(call.arguments, '{"command":"ls"}')
})

test('token 估算：中文按字，英文按四字符', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('中文字符'), 4)
  // 8 个字符的英文约 2 个 token
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.ok(estimateTokens('中文 and english mixed') > 0)
})

async function readEvents(stream) {
  const events = []
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    for (const block of decoder.decode(chunk).split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data: '))
      if (line) events.push(JSON.parse(line.slice(6)))
    }
  }
  return events
}

test('流式 responses + 工具：产出 function_call item，而不是把工具 JSON 当文本', async () => {
  const meta = { id: 'chatcmpl-1', created: 1, model: 'doubao-glm-5-3' }
  const message = {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }],
  }
  const stream = responsesEventStreamFromMessage(meta, message, (text) => ({
    input_tokens: 1, output_tokens: estimateTokens(text), total_tokens: 1 + estimateTokens(text),
  }))
  const events = await readEvents(stream)
  const types = events.map((e) => e.type)
  assert.ok(types.includes('response.function_call_arguments.delta'))
  assert.ok(types.includes('response.function_call_arguments.done'))
  const done = events.find((e) => e.type === 'response.output_item.done' && e.item?.type === 'function_call')
  assert.equal(done.item.call_id, 'call_1')
  assert.equal(done.item.name, 'shell')
  assert.equal(done.item.arguments, '{"command":"ls"}')
  const completed = events.find((e) => e.type === 'response.completed')
  assert.equal(completed.response.status, 'completed')
  assert.equal(completed.response.output.find((x) => x.type === 'function_call').call_id, 'call_1')
})

test('流式 responses + 文本 + 工具：先 message 后 function_call，索引递增', async () => {
  const meta = { id: 'c', created: 1, model: 'm' }
  const message = {
    role: 'assistant',
    content: '先列个目录',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }],
  }
  const events = await readEvents(responsesEventStreamFromMessage(meta, message, () => ({ input_tokens: 1, output_tokens: 1, total_tokens: 2 })))
  const added = events.filter((e) => e.type === 'response.output_item.added')
  assert.equal(added[0].item.type, 'message')
  assert.equal(added[0].output_index, 0)
  assert.equal(added[1].item.type, 'function_call')
  assert.equal(added[1].output_index, 1)
  const completed = events.find((e) => e.type === 'response.completed')
  assert.equal(completed.response.output.length, 2)
})
