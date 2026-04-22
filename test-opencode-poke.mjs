#!/usr/bin/env node
/**
 * 手动测试 opencode-poke-transport 的完整链路:
 * 1. 连接到 daemon MCP
 * 2. 注册 agent
 * 3. 绑定 opencode session
 * 4. 发送 poke
 * 5. 验证 opencode session 收到消息
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const MCP_URL = 'http://127.0.0.1:9100/mcp'
const OPENCODE_BASE_URL = 'http://127.0.0.1:4096'
const SESSION_ID = 'ses_25123ad2affeZxxMmrPHR8YLPs'

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  console.log('=== 手动测试 opencode-poke-transport ===\n')

  // 1. 连接 MCP
  console.log('1. 连接到 daemon MCP...')
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  console.log('   ✓ MCP 连接成功\n')

  // 2. 注册 target agent (将绑定 opencode session)
  console.log('2. 注册 target agent...')
  const registerResult = await client.callTool({
    name: 'register_agent',
    arguments: {
      model: 'anthropic/claude-3-5-sonnet-20241022',
      name: 'test-opencode-target',
      team: 'test',
      role: 'worker'
    }
  })
  console.log('   结果:', JSON.stringify(registerResult, null, 2), '\n')
  const targetAgentId = JSON.parse(registerResult.content[0].text).agent_id

  // 3. 绑定 opencode session
  console.log('3. 绑定 opencode session...')
  const bindResult = await client.callTool({
    name: 'bind_opencode_session',
    arguments: {
      base_url: OPENCODE_BASE_URL,
      session_id: SESSION_ID
    }
  })
  console.log('   结果:', JSON.stringify(bindResult, null, 2), '\n')

  // 4. 断开当前 session，用新 session 作为 caller 来 poke (避免 self_poke_denied)
  console.log('4. 用新 session 注册 caller agent...')
  await client.close()
  
  const transport2 = new StreamableHTTPClientTransport(new URL(MCP_URL))
  const client2 = new Client({ name: 'test-client-2', version: '1.0.0' })
  await client2.connect(transport2)
  
  const registerCallerResult = await client2.callTool({
    name: 'register_agent',
    arguments: {
      model: 'anthropic/claude-3-5-sonnet-20241022',
      name: 'test-opencode-caller',
      team: 'test',
      role: 'worker'
    }
  })
  console.log('   Caller 注册结果:', JSON.stringify(registerCallerResult, null, 2), '\n')

  // 5. 发送 poke
  console.log('5. 发送 poke...')
  const pokeResult = await client2.callTool({
    name: 'poke',
    arguments: {
      target_agent_id: targetAgentId,
      prompt: 'Hello from opencode-poke-transport test!'
    }
  })
  console.log('   结果:', JSON.stringify(pokeResult, null, 2), '\n')

  // 6. 验证 opencode session 消息 (检查消息列表)
  console.log('6. 验证 opencode session 消息...')
  await sleep(2000) // 等待消息处理
  const messages = await fetch(`${OPENCODE_BASE_URL}/session/${SESSION_ID}/message`).then((r) => r.json())
  console.log('   Session 消息数:', messages.length)
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1]
    console.log('   最新消息:', JSON.stringify(lastMsg, null, 2))
  }

  await client2.close()
  console.log('\n=== 测试完成 ===')
}

main().catch(console.error)
