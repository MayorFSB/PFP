// Панель диалогов управляющего: список клиентов слева, переписка справа.
async function loadChatList() {
    const res = await fetch('/api/v1/chat/conversations');
    if (!res.ok) return;
    const data = await res.json();
    renderChatList(data);
}
function renderChatList(convs) {
    const el = document.getElementById('chat-list');
    if (!convs.length) { el.innerHTML = '<div class="chat-empty">Нет активных диалогов</div>'; return; }
    el.innerHTML = convs.map(c => `
        <div class="chat-item" data-user-id="${c.user_id}">
            <strong>${c.client_name}</strong>
            <small>${c.last_msg}</small>
            <span class="time">${c.last_time}</span>
        </div>
    `).join('');
    el.querySelectorAll('.chat-item').forEach(item => {
        item.addEventListener('click', () => openChatDetail(item.dataset.userId, item.querySelector('strong').textContent));
    });
}
async function openChatDetail(userId, clientName) {
    document.getElementById('chat-detail').style.display = 'flex';
    document.getElementById('chat-client-name').textContent = clientName;
    document.getElementById('target_user_id').value = userId;
    const res = await fetch(`/api/v1/chat/history/${userId}`);
    if (res.ok) {
        const msgs = await res.json();
        renderChatDetail(msgs);
    }
}
function closeChatDetail() {
    document.getElementById('chat-detail').style.display = 'none';
}
function renderChatDetail(msgs) {
    const el = document.getElementById('chat-detail-msgs');
    if (!msgs.length) { el.innerHTML = '<div class="chat-empty">Пусто</div>'; return; }
    el.innerHTML = msgs.map(m => `
        <div class="chat-msg ${m.role === 'user' ? 'client' : 'manager'}">
            <div class="bubble">${escapeHtml(m.content)}</div>
            <small class="time">${m.created_at}</small>
        </div>
    `).join('');
    el.scrollTop = el.scrollHeight;
}
function escapeHtml(t) { return t.replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>'); }
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chat-detail-close').addEventListener('click', closeChatDetail);
    document.getElementById('manager-chat-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const res = await fetch('/api/v1/chat/send', {method:'POST', body:fd});
        if (res.ok) {
            const data = await res.json();
            if (data.reply) {
                const el = document.getElementById('chat-detail-msgs');
                const div = document.createElement('div');
                div.className = 'chat-msg manager';
                div.innerHTML = `<div class="bubble">${escapeHtml(data.reply)}</div><small class="time">${new Date().toLocaleTimeString()}</small>`;
                el.appendChild(div);
                el.scrollTop = el.scrollHeight;
            }
            e.target.message.value = '';
        }
    });
    loadChatList();
    setInterval(loadChatList, 30000);
});
