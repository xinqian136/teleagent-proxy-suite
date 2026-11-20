'use strict';
/**
 * proxy/client-config.js — 生成客户端配置
 *
 * 目标：用户不用想「base_url 是什么」，直接把生成好的东西贴进客户端。
 */

const fs = require('fs');
const path = require('path');

/**
 * 各种客户端的配置片段
 * @param {object} o { baseUrl, apiKey, model }
 */
function buildConfigs(o) {
  const baseUrl = o.baseUrl;
  const apiKey = o.apiKey;
  const model = o.model;

  return {
    '通用（OpenAI 兼容）': [
      `Base URL : ${baseUrl}`,
      `API Key  : ${apiKey}`,
      `Model    : ${model}`,
    ].join('\n'),

    'Cherry Studio': [
      '设置 → 模型服务 → 添加 OpenAI 兼容服务',
      `  API 地址 : ${baseUrl}`,
      `  API 密钥 : ${apiKey}`,
      '  模型     : 勾选「添加模型」→ 填 ' + model,
    ].join('\n'),

    'Cline / Roo Code': [
      '设置 → API Provider → OpenAI Compatible',
      `  Base URL : ${baseUrl}`,
      `  API Key  : ${apiKey}`,
      `  Model ID : ${model}`,
    ].join('\n'),

    'Cursor': [
      '设置 → Models → OpenAI API Key',
      `  Override OpenAI Base URL : ${baseUrl}`,
      `  API Key                  : ${apiKey}`,
      `  Model                    : ${model}`,
    ].join('\n'),

    'WorkBuddy / 其它': [
      '在设置里找「自定义模型 / OpenAI 兼容」，填这三行：',
      `  base_url = ${baseUrl}`,
      `  api_key  = ${apiKey}`,
      `  model    = ${model}`,
    ].join('\n'),

    'curl 测试': [
      `curl ${baseUrl}/chat/completions \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -H "Authorization: Bearer ${apiKey}" \\`,
      `  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`,
    ].join('\n'),
  };
}

/**
 * 写一份配置文件到磁盘，方便直接看/拷
 */
function writeConfigFile(dir, o) {
  const configs = buildConfigs(o);
  const lines = [
    '='.repeat(60),
    '  TeleAgent 反代 v2 —— 客户端配置',
    '='.repeat(60),
    '',
    `  服务地址 : ${o.baseUrl}`,
    `  密钥     : ${o.apiKey}`,
    `  模型     : ${o.model}`,
    '',
    '='.repeat(60),
    '',
  ];
  for (const [name, body] of Object.entries(configs)) {
    lines.push(`【${name}】`);
    lines.push(body);
    lines.push('');
    lines.push('-'.repeat(60));
    lines.push('');
  }
  lines.push('提示：模型名也可以用 chat-pro / chat-lite / chat-flash / chat-nano');
  lines.push('      chat-flash 最快，chat-flagship 最强。');
  lines.push('');

  const out = path.join(dir, '客户端配置.txt');
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  return { path: out, content: lines.join('\n') };
}

module.exports = { buildConfigs, writeConfigFile };
