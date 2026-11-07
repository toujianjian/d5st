(function() {
  'use strict';

  // ============================================================
  // CSRF 自动回填
  // ------------------------------------------------------------
  // 服务端用「双提交 Cookie」：csrf_token 是非 httpOnly 的 cookie，
  // 写操作必须把它回填到 X-CSRF-Token 头（fetch）或 _csrf 字段（表单）。
  // 这里统一劫持 fetch / XHR 并给所有表单补隐藏域，
  // 业务代码不用关心，也避免漏改某个表单导致 403。
  // ============================================================
  function readCookie(name) {
    var m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(document.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function csrfToken() {
    return readCookie('csrf_token');
  }

  // 1) 给所有表单补 _csrf 隐藏域（含之后动态插入的）
  function injectFormToken(form) {
    if (!form || form.method.toLowerCase() === 'get') return;
    if (form.querySelector('input[name="_csrf"]')) return;
    var token = csrfToken();
    if (!token) return;
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = '_csrf';
    input.value = token;
    form.appendChild(input);
  }

  function injectAllFormTokens(root) {
    (root || document).querySelectorAll('form').forEach(injectFormToken);
  }

  // 2) 劫持 fetch：同源写请求自动带 X-CSRF-Token
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function(input, init) {
      init = init || {};
      var method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        var token = csrfToken();
        if (token) {
          var headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || {});
          if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
          init.headers = headers;
        }
      }
      return nativeFetch.call(window, input, init);
    };
  }

  // 3) 劫持 XMLHttpRequest：老代码用 XHR 发写请求时同样带上
  var nativeXhrOpen = XMLHttpRequest.prototype.open;
  var nativeXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method) {
    this.__csrfMethod = String(method || 'GET').toUpperCase();
    return nativeXhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    if (this.__csrfMethod && ['GET', 'HEAD', 'OPTIONS'].indexOf(this.__csrfMethod) < 0) {
      var token = csrfToken();
      if (token) {
        try { this.setRequestHeader('X-CSRF-Token', token); } catch (e) { /* 已发送则忽略 */ }
      }
    }
    return nativeXhrSend.apply(this, arguments);
  };

  function loadPopups() {
    var container = document.getElementById('popup-container');
    if (!container) return;

    var page = document.body.dataset.page || 'home';
    
    fetch('/api/popups?page=' + encodeURIComponent(page))
      .then(function(r) { return r.json(); })
      .then(function(popups) {
        popups.forEach(function(popup) {
          showPopup(popup);
        });
      })
      .catch(function(err) {
        console.warn('弹窗加载失败:', err);
      });
  }

  function showPopup(popup) {
    var overlay = document.createElement('div');
    overlay.className = 'popup-overlay';
    // 安全说明：popup.content 由管理员在后台录入，这里用 textContent 而非 innerHTML 赋值，
    // 避免后台账号被盗后写入 <script>/<img onerror> 造成存储型 XSS。
    overlay.innerHTML =
      '<div class="popup-box">' +
        '<div class="popup-header">' +
          '<span class="popup-title"></span>' +
          '<button class="popup-close" aria-label="关闭">&times;</button>' +
        '</div>' +
        '<div class="popup-body"></div>' +
      '</div>';
    overlay.querySelector('.popup-title').textContent = popup.title || '';
    overlay.querySelector('.popup-body').textContent = popup.content || '';
    
    overlay.querySelector('.popup-close').addEventListener('click', function() {
      closePopup(overlay, popup.id);
    });
    
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closePopup(overlay, popup.id);
    });
    
    document.getElementById('popup-container').appendChild(overlay);
  }

  function closePopup(overlay, popupId) {
    overlay.remove();
    if (popupId) {
      fetch('/api/popups/' + popupId + '/close', { method: 'POST' }).catch(function() {});
    }
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function initForumFeatures() {
    document.querySelectorAll('.like-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var postId = this.dataset.postId;
        fetch('/forum/like/' + postId, { method: 'POST' })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            btn.dataset.liked = data.liked ? '1' : '0';
            var countEl = btn.querySelector('.like-count');
            if (countEl) {
              var count = parseInt(countEl.textContent) || 0;
              countEl.textContent = data.liked ? count + 1 : Math.max(0, count - 1);
            }
          });
      });
    });

    document.querySelectorAll('.comment-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var postId = this.dataset.postId;
        var input = document.getElementById('comment-input-' + postId);
        if (!input || !input.value.trim()) return;
        
        fetch('/forum/comment/' + postId, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: input.value.trim() })
        }).then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.success) {
              input.value = '';
              loadComments(postId);
            }
          });
      });
    });
  }

  function loadComments(postId) {
    fetch('/forum/comments/' + postId)
      .then(function(r) { return r.json(); })
      .then(function(comments) {
        var list = document.getElementById('comments-' + postId);
        if (!list) return;
        // 安全说明：c.avatar 可能来自 Casdoor 外链，必须转义后再拼进 HTML，
        // 否则恶意头像 URL 可注入 "><img onerror=...> 造成 XSS。
        list.innerHTML = comments.map(function(c) {
          return '<div class="post-item"><div class="post-avatar">' + escapeHtml(c.avatar || '👤') + '</div><div class="post-body"><div class="post-meta">' + escapeHtml(c.real_name || c.username || '匿名') + ' · ' + escapeHtml(new Date(c.created_at).toLocaleString('zh-CN')) + '</div><div class="post-content">' + escapeHtml(c.content) + '</div></div></div>';
        }).join('');
      });
  }

  function initChat() {
    var form = document.getElementById('chat-form');
    if (!form) return;
    var input = document.getElementById('chat-input');
    var messagesEl = document.querySelector('.chat-messages');
    
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      if (!input.value.trim()) return;
      
      fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input.value.trim() })
      }).then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            var msg = document.createElement('div');
            msg.className = 'chat-msg sent';
            msg.textContent = input.value.trim();
            messagesEl.appendChild(msg);
            input.value = '';
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        });
    });
    
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ============================================================
  // 后台表格：统一套一层横向滚动容器
  // ------------------------------------------------------------
  // 后台 20 个页面里只有少数自带 overflow-x 容器，其余表格
  // 最小内容宽度约 1800px，在手机(390px)上被裁掉且无法滚动 ——
  // 表现为「置顶/精华/删除」等右侧按钮完全点不到。
  // 这里在渲染后统一包一层 .table-scroll，CSS 见 admin/_style.ejs。
  // ============================================================
  function wrapAdminTables(root) {
    (root || document).querySelectorAll('.admin-content table').forEach(function(table) {
      // 已经被包过（或自己就是滚动容器）就跳过
      if (table.closest('.table-scroll')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    injectAllFormTokens(document);
    wrapAdminTables(document);
    loadPopups();
    initForumFeatures();
    initChat();
  });

  // 动态插入的节点（弹窗、异步评论列表等）也补上 token
  if (window.MutationObserver) {
    new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'FORM') injectFormToken(node);
          else injectAllFormTokens(node);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
