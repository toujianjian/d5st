// 开发环境邮件接收端（SMTP sink）
//
// 用途：Casdoor 发送「找回密码」验证码时，本地不希望真的外发邮件。
// 这里起一个最小 SMTP 服务收下邮件，并通过 8025 端口的网页列出验证码。
//
// 关键：EHLO 响应里**故意不通告 AUTH**。Casdoor 用的 gomail 一旦发现服务器
// 支持 AUTH，就会尝试在未加密连接上发送凭据并直接报
// "unencrypted connection"（MailHog 就是因为这个不能用）。
// 不通告 AUTH 时 gomail 会跳过认证直接投递。
import net from 'node:net';
import http from 'node:http';

const messages = [];
let seq = 0;

function decodeQP(s) {
  return s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function extractCode(m) {
  const text = decodeQP(m.body);
  // Casdoor 验证码默认 6 位；邮件里还有日期等其它数字，优先按 6 位取，
  // 否则再退化到 5 位 / 4-8 位，避免把日期里的年份当成验证码
  return (text.match(/\b\d{6}\b/)
    || text.match(/\b\d{5}\b/)
    || text.match(/\b\d{4,8}\b/)
    || [''])[0];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const smtp = net.createServer(sock => {
  sock.write('220 d5st-mail ESMTP ready\r\n');
  let buf = '';
  let inData = false;
  let current = null;

  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      if (inData) {
        if (line === '.') {
          inData = false;
          messages.push(current);
          console.log(`[d5st-mail] 收到邮件 #${current.id}: ${current.from} -> ${current.to} 验证码=${extractCode(current) || '(无)'}`);
          console.log(`[d5st-mail] 正文片段: ${decodeQP(current.body).replace(/\s+/g, ' ').slice(0, 300)}`);
          sock.write('250 OK queued\r\n');
          current = null;
        } else {
          current.body += line + '\n';
        }
        continue;
      }

      const cmd = line.trim();
      const up = cmd.toUpperCase();
      if (up.startsWith('EHLO') || up.startsWith('HELO')) {
        // 只宣告基础能力，不宣告 AUTH
        sock.write('250-d5st-mail\r\n250 SIZE 10485760\r\n');
      } else if (up.startsWith('MAIL FROM')) {
        current = {
          id: ++seq,
          from: cmd.slice(10).replace(/[<>]/g, '').trim(),
          to: '',
          body: '',
          at: new Date().toISOString()
        };
        sock.write('250 OK\r\n');
      } else if (up.startsWith('RCPT TO')) {
        if (current) {
          const to = cmd.slice(8).replace(/[<>]/g, '').trim();
          current.to = current.to ? `${current.to}, ${to}` : to;
        }
        sock.write('250 OK\r\n');
      } else if (up === 'DATA') {
        inData = true;
        sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (up === 'QUIT') {
        sock.write('221 Bye\r\n');
        sock.end();
      } else {
        sock.write('250 OK\r\n');
      }
    }
  });

  sock.on('error', () => {});
});

smtp.listen(1025, '0.0.0.0', () => console.log('[d5st-mail] SMTP 监听 1025'));

http.createServer((req, res) => {
  // JSON 接口：便于脚本/调试直接取完整邮件正文
  if (req.url === '/api/messages') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      total: messages.length,
      items: messages.slice().reverse().map(m => ({ id: m.id, at: m.at, from: m.from, to: m.to, body: decodeQP(m.body) }))
    }));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const list = messages.slice().reverse();
  const rows = list.map(m => `
      <tr>
        <td>${m.id}</td>
        <td>${escapeHtml(m.at)}</td>
        <td>${escapeHtml(m.to)}</td>
        <td><code>${escapeHtml(extractCode(m))}</code></td>
      </tr>`).join('');
  res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>D5ST 开发邮箱</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; }
    table { border-collapse: collapse; width: 100%; }
    td, th { border: 1px solid #ddd; padding: 8px; text-align: left; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 15px; }
  </style>
</head>
<body>
  <h2>D5ST 开发邮箱（共 ${messages.length} 封）</h2>
  ${list.length
      ? `<table><tr><th>#</th><th>时间</th><th>收件人</th><th>验证码</th></tr>${rows}</table>`
      : '<p>暂无邮件。可在站点点「忘记密码」触发一封验证码邮件。</p>'}
</body>
</html>`);
}).listen(8025, '0.0.0.0', () => console.log('[d5st-mail] Web 界面监听 8025'));
