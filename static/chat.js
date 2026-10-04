// Chat panel for client cabinet
let ws = null;

function toggleChat() {
    const body = document.getElementById('chat-body');
    const toggle = document.getElementById('chat-toggle');
    const shown = body.style.display !== 'none';
    body.style.display = shown ? 'none' : 'block';
    toggle.textContent = shown ? '▼' : '▲';
    if (!shown && !ws) connectWS();
}

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/chat`);
    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'message') appendMsg(data.role, data.content);
    };
    ws.onclose = () => { ws = null; };
}

function appendMsg(role, content) {
    const container = document.getElementById('chat-messages');
    if (container.querySelector('.chat-empty')) container.innerHTML = '';
    const div = document.createElement('div');
    div.className = `chat-msg ${role === 'user' ? 'me' : 'bot'}`;
    div.innerHTML = `<div class="bubble">${escapeHtml(content)}</div><small class="time">${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</small>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function escapeHtml(t) { return t.replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>'); }

document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('.chat-header');
    if (header) {
        header.addEventListener('click', toggleChat);
    }
    const form = document.getElementById('chat-form');
    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = e.target.message;
            const text = input.value.trim();
            if (!text || !ws) return;
            appendMsg('user', text);
            ws.send(JSON.stringify({type:'message', content:text}));
            input.value = '';
        });
    }
});