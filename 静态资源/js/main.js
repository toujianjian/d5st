(function() {
  'use strict';

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
    overlay.innerHTML = 
      '<div class="popup-box">' +
        '<div class="popup-header">' +
          '<span class="popup-title">' + escapeHtml(popup.title) + '</span>' +
          '<button class="popup-close" aria-label="关闭">&times;</button>' +
        '</div>' +
        '<div class="popup-body">' + popup.content + '</div>' +
      '</div>';
    
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
        list.innerHTML = comments.map(function(c) {
          return '<div class="post-item"><div class="post-avatar">' + (c.avatar || '👤') + '</div><div class="post-body"><div class="post-meta">' + escapeHtml(c.real_name || c.username || '匿名') + ' · ' + new Date(c.created_at).toLocaleString('zh-CN') + '</div><div class="post-content">' + escapeHtml(c.content) + '</div></div></div>';
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

  document.addEventListener('DOMContentLoaded', function() {
    loadPopups();
    initForumFeatures();
    initChat();
  });
})();
