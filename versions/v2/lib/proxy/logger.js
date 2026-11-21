'use strict';
/**
 * proxy/logger.js — 简单日志
 *
 * 写 data/tav2.log，同时输出到控制台。
 */

const fs = require('fs');
const path = require('path');

function createLogger(opts = {}) {
  const logFile = opts.logFile || null;
  const quiet = !!opts.quiet;
  const maxSize = opts.maxSize || 2 * 1024 * 1024;

  function write(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    if (!quiet) {
      if (level === 'ERROR') console.error(line);
      else if (level === 'WARN') console.warn(line);
      else console.log(line);
    }
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        // 简单的大小控制：超过上限就清空重写
        try {
          if (fs.existsSync(logFile) && fs.statSync(logFile).size > maxSize) {
            fs.writeFileSync(logFile, line + '\n');
            return;
          }
        } catch (_) {}
        fs.appendFileSync(logFile, line + '\n');
      } catch (_) {}
    }
  }

  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    log: (m) => write('INFO', m),
    raw: (m) => { if (!quiet) console.log(m); },
  };
}

module.exports = { createLogger };
